/** Where a piece of evidence came from. A verdict is only as live as its weakest input. */
export type Provenance = "live" | "replay" | "simulated";

const ORDER: Provenance[] = ["live", "replay", "simulated"];

/** The least live of the inputs. No inputs reads as simulated, never as live. */
export function weakest(inputs: Provenance[]): Provenance {
  if (inputs.length === 0) return "simulated";
  return inputs.reduce((w, p) => (ORDER.indexOf(p) > ORDER.indexOf(w) ? p : w));
}

/** Deliveries from the signed-envelope simulator and the test fixtures carry a SIMULATOR or FIXTURE account id inside the signed body. */
export const eventProvenance = (accountId: string): Provenance => (/SIMULATOR|FIXTURE/i.test(accountId) ? "simulated" : "live");
