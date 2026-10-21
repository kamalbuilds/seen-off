import type { TrackingSource } from "../pickup/runner.ts";
import type { LabelRow } from "../store/ledger.ts";
import type { TrackingStatus } from "../pickup/verdict.ts";

const STATUSES: ReadonlySet<string> = new Set(["PRE_TRANSIT", "TRANSIT", "DELIVERED", "RETURNED", "FAILURE", "UNKNOWN"]);

export class ShippoError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`shippo ${status}: ${detail}`);
    this.status = status;
  }
}

export interface ShippoAddress {
  name: string; street1: string; city: string; state: string; zip: string; country: string; phone?: string; email?: string;
}

export interface ShippoParcel {
  length: string; width: string; height: string; distance_unit: "in" | "cm"; weight: string; mass_unit: "lb" | "oz" | "kg" | "g";
}

export interface Label {
  trackingNumber: string;
  carrier: string;
  labelUrl: string;
  transactionId: string;
}

/** Shippo REST, auth header `Authorization: ShippoToken <key>`. A shippo_test_ key stays in test mode: test labels, mock tracking numbers. */
export class ShippoClient {
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(apiKey: string, base = "https://api.goshippo.com", fetchImpl: typeof fetch = fetch) {
    this.#key = apiKey;
    this.#base = base;
    this.#fetch = fetchImpl;
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `ShippoToken ${this.#key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new ShippoError(res.status, (await res.text()).slice(0, 300));
    return (await res.json()) as T;
  }

  /** Buy the cheapest rate for one parcel. Returns only on a SUCCESS transaction, because a 201 alone is an accepted request, not a label. */
  async createLabel(from: ShippoAddress, to: ShippoAddress, parcel: ShippoParcel): Promise<Label> {
    const shipment = await this.#json<{ rates: { object_id: string; amount: string; provider: string }[] }>("POST", "/shipments/", {
      address_from: from, address_to: to, parcels: [parcel], async: false,
    });
    if (!shipment.rates?.length) throw new ShippoError(422, "shipment returned no rates");
    const rate = [...shipment.rates].sort((a, b) => Number(a.amount) - Number(b.amount))[0];
    const tx = await this.#json<{ object_id: string; status: string; tracking_number: string; label_url: string; messages?: unknown[] }>(
      "POST", "/transactions/", { rate: rate.object_id, label_file_type: "PDF", async: false },
    );
    if (tx.status !== "SUCCESS" || !tx.tracking_number || !tx.label_url) {
      throw new ShippoError(422, `transaction ${tx.status}: ${JSON.stringify(tx.messages ?? []).slice(0, 200)}`);
    }
    return { trackingNumber: tx.tracking_number, carrier: rate.provider.toLowerCase(), labelUrl: tx.label_url, transactionId: tx.object_id };
  }

  /** GET /tracks/{carrier}/{number}. In test mode use carrier "shippo" with SHIPPO_PRE_TRANSIT, SHIPPO_TRANSIT, SHIPPO_DELIVERED, SHIPPO_RETURNED, SHIPPO_FAILURE, SHIPPO_UNKNOWN. */
  async trackingStatus(carrier: string, trackingNumber: string): Promise<TrackingStatus> {
    const t = await this.#json<{ tracking_status?: { status?: string } | null }>("GET", `/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(trackingNumber)}`);
    const s = t.tracking_status?.status;
    if (s === undefined) return "UNKNOWN";
    if (!STATUSES.has(s)) throw new ShippoError(502, `unrecognised tracking status ${s}`);
    return s as TrackingStatus;
  }

  /** Reschedule a carrier pickup for labels already bought (Shippo Pickups API). */
  async schedulePickup(args: { carrierAccount: string; transactionIds: string[]; address: ShippoAddress; startIso: string; endIso: string; testMode: boolean }): Promise<{ confirmationCode: string; status: string }> {
    const p = await this.#json<{ confirmation_code?: string; status: string; messages?: unknown[] }>("POST", "/pickups/", {
      carrier_account: args.carrierAccount,
      location: { building_location_type: "Front Door", address: args.address },
      transactions: args.transactionIds,
      requested_start_time: args.startIso,
      requested_end_time: args.endIso,
      is_test: args.testMode,
    });
    if (p.status !== "CONFIRMED" || !p.confirmation_code) throw new ShippoError(422, `pickup ${p.status}: ${JSON.stringify(p.messages ?? []).slice(0, 200)}`);
    return { confirmationCode: p.confirmation_code, status: p.status };
  }
}

export class ShippoTracking implements TrackingSource {
  readonly #client: ShippoClient;
  /** A shippo_test_ key answers with Shippo's canned test-number statuses, so it is labelled simulated. Only a live key is live. */
  readonly provenance: "live" | "simulated";

  constructor(apiKey: string) {
    this.#client = new ShippoClient(apiKey);
    this.provenance = apiKey.startsWith("shippo_test_") ? "simulated" : "live";
  }

  statusOf(label: LabelRow): Promise<TrackingStatus> {
    return this.#client.trackingStatus(label.carrier, label.trackingNumber);
  }
}
