#!/bin/sh
set -eu

control_url="${OMC_CONTROL_URL:-http://host.docker.internal:3000}"
curl --fail --silent --show-error "${control_url%/}/api/company"
