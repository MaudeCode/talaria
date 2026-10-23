#!/usr/bin/env bash
# ci/memory-sampler against fake top, sysctl, memory_pressure, vm_stat and footprint; reads nothing from this machine.
# Assertions use [ ], not [[ ]]: macOS bash 3.2 does not exit on a failed [[ ]] under set -e.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/memory-sampler"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
# Keep elapsed-time assertions independent of probes crossing a wall-clock second.
export MEMORY_SAMPLER_TEST_SOURCE="$script"
cat > "$work/bin/sampler" <<'EOF'
#!/usr/bin/env bash
unset SECONDS # Disable Bash's automatic updates.
SECONDS=0
sleep() { SECONDS=$((SECONDS + $1)); }
source "$MEMORY_SAMPLER_TEST_SOURCE" "$@"
EOF
script="$work/bin/sampler"
chmod +x "$script"
# Each fake prints the fixture for the current sample, "$work/n".
for tool in top sysctl memory_pressure vm_stat footprint; do
  # shellcheck disable=SC2016 # The fake expands $(cat n) when it runs.
  printf '#!/usr/bin/env bash\ncat "%s/%s.$(cat "%s/n")"\n' "$work" "$tool" "$work" > "$work/bin/$tool"
  chmod +x "$work/bin/$tool"
done
export PATH="$work/bin:$PATH"
log="$work/memory.log" xcodebuild_log="$work/xcodebuild.log"

# fixture N SWAP_USED_MB SIMRENDERSERVER_MEM SIMRENDERSERVER_PEAK_BYTES
fixture() {
  printf 'total = 3072.00M  used = %s  free = 0.00M  (encrypted)\n' "$2" > "$work/sysctl.$1"
  printf 'Processes: 400 total\nPID    COMMAND          MEM\n3800   SimRenderServer  %s\n5560   xcodebuild       245M\n18223  Talaria          76M\n' "$3" > "$work/top.$1"
  echo "System-wide memory free percentage: 12%" > "$work/memory_pressure.$1"
  printf 'Pages stored in compressor:    100.\nSwapins:     7.\nSwapouts:    9.\nPages free:  1.\n' > "$work/vm_stat.$1"
  printf 'Auxiliary data:\n    phys_footprint: 1 B\n    phys_footprint_peak: %s B\n' "$4" > "$work/footprint.$1"
}
started() { echo "Test Case '-[TalariaTests.$1]' started." >> "$xcodebuild_log"; }
sample() { echo "$1" > "$work/n"; "$script" sample "$log" "$xcodebuild_log"; }

# Before any test starts; then swap peaks during one test and SimRenderServer (in G) during another.
fixture 1 0.00M 300M 734003200
sample 1
started "ChatHostedTests testOpens"
fixture 2 2048.50M 1.5G 2147483648
sample 2
echo "Test Case '-[TalariaTests.ChatHostedTests testOpens]' passed (1.000 seconds)." >> "$xcodebuild_log"
started "StreamHostedTests testSteers"
fixture 3 2900.00M 2860M+ 3221225472
sample 3
fixture 4 1024.00M 512K 3221225472
sample 4

[ "$(grep -c '^=== ' "$log")" = 4 ]
grep -q '^=== .* test: none$' "$log"
grep -q '^SimRenderServer: 2860M+ (peak 3072 MB)$' "$log"
grep -q '^Pages stored in compressor: 100.;Swapins: 7.;Swapouts: 9.$' "$log"
grep -q '^System-wide memory free percentage: 12%$' "$log"
grep -q '^5560   xcodebuild       245M$' "$log"
[ "$(grep '^#sample' "$log" | cut -f 3-)" = $'0\t300\tnone\t700\n2048\t1536\tChatHostedTests testOpens\t2048\n2900\t2860\tStreamHostedTests testSteers\t3072\n1024\t0\tStreamHostedTests testSteers\t3072' ]
# The lifetime peak catches a spike between samples, or while a starved runner stalls the sampler: the first sample
# whose peak reached the maximum names the test that was running.
[ "$("$script" summary "$log")" = "- Memory peaks over 4 samples: swap used 2900 MB (StreamHostedTests testSteers); SimRenderServer 2860 MB (StreamHostedTests testSteers); SimRenderServer lifetime peak 3072 MB (first seen in StreamHostedTests testSteers)" ]

# An unreadable peak records 0 rather than losing the sample.
printf 'phys_footprint_peak: unavailable\n' > "$work/footprint.4"
sample 4
[ "$(grep '^#sample' "$log" | tail -n 1 | cut -f 3-)" = $'1024\t0\tStreamHostedTests testSteers\t0' ]
[ "$(grep -c '^#sample' "$log")" = 5 ]

# A missing SimRenderServer or xcodebuild log still samples; an empty log says so.
printf 'PID    COMMAND          MEM\n1  launchd  12M\n' > "$work/top.4"
rm "$xcodebuild_log"
sample 4
grep -q '^SimRenderServer: not running$' "$log"
[ "$(grep '^#sample' "$log" | tail -n 1 | cut -f 3-)" = $'1024\t0\tnone\t0' ]
[ "$("$script" summary /dev/null)" = "- Memory: no samples" ]

# settle returns once the burst came and went, and gives up at its cap while the burst runs, has not come, or
# SimRenderServer is not running yet (TAL-696).
fixture 5 0.00M 300M 3221225472
echo 5 > "$work/n"
[ "$("$script" settle 600)" = "SimRenderServer settled after 0 s: 300 MB, lifetime peak 3072 MB" ]
fixture 5 0.00M 2860M+ 3221225472
[ "$(MEMORY_SETTLE_POLL_SECONDS=0 "$script" settle 0)" = "SimRenderServer had not settled after 0 s: 2860 MB, lifetime peak 3072 MB" ]
[ "$(MEMORY_SETTLE_POLL_SECONDS=10 "$script" settle 20)" = "SimRenderServer had not settled after 20 s: 2860 MB, lifetime peak 3072 MB" ]
fixture 5 0.00M 300M 734003200
[ "$(MEMORY_SETTLE_POLL_SECONDS=0 "$script" settle 0)" = "SimRenderServer had not settled after 0 s: 300 MB, lifetime peak 700 MB" ]
printf 'PID    COMMAND          MEM\n1  launchd  12M\n' > "$work/top.5"
[ "$(MEMORY_SETTLE_POLL_SECONDS=0 "$script" settle 0)" = "SimRenderServer had not settled after 0 s: 0 MB, lifetime peak 0 MB" ]
echo "memory-sampler tests passed"
