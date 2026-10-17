#!/bin/bash
# Records a good run of a job (ADR 171). Each job's unit runs it as root after the job
# succeeds (ExecStartPost=+...). Usage: heartbeat.sh <job>
set -euo pipefail
source "$(dirname "$0")/lib.sh"
heartbeat "${1:?usage: heartbeat.sh <job>}" true
