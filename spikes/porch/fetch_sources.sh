#!/usr/bin/env bash
# Fetches the public source media for the porch spike into spikes/porch/src (gitignored) and checks sha256.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p src
UA="seen-off-spike/0.1 (github.com/kamalbuilds)"
get() { # name url
  [ -s "src/$1" ] || curl -sfL -A "$UA" -o "src/$1" "$2"
}
get front_porch_theft.ogv "https://upload.wikimedia.org/wikipedia/commons/4/41/Front_Porch_Theft_2012_11_17_101117.ogv"
get dont_tempt.ogv "https://upload.wikimedia.org/wikipedia/commons/e/e8/Don%27t_Tempt_a_Thief_with_Unattended_Parcels.ogv"
get damaged_box.jpg "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b7/Damaged_fragile_parcel_delivered_to_doorstep.jpg/1280px-Damaged_fragile_parcel_delivered_to_doorstep.jpg"
shasum -a 256 src/* | tee src.sha256
