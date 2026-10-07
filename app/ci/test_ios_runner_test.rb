#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require "json"
require "yaml"

class TestIOSRunnerTest < Minitest::Test
  WORKFLOWS = File.expand_path("../../.github/workflows", __dir__)

  def workflow_text(name) = File.read(File.join(WORKFLOWS, name), encoding: "UTF-8")
  def workflow_jobs(name) = YAML.safe_load_file(File.join(WORKFLOWS, name), aliases: true)["jobs"]
  def test_disables_slow_xcode_failure_diagnostics
    script = File.read(File.expand_path("../scripts/test-ios", __dir__))

    assert_includes(script, "-collect-test-diagnostics never")
  end

  def test_hosted_shards_skip_simulator_diagnostics_and_end_inside_their_job
    shard = workflow_jobs("app-tests.yml").fetch("app-test")
    test = shard["steps"].find { |step| step["name"] == "Test without building" }

    # Collecting a hosted simulator's diagnostics waited 600 s on every shard and returned none (TAL-669); the
    # result bundle still keeps each failure's screenshots, recording and logs.
    assert_includes(test["run"], "-collect-test-diagnostics never")
    refute_match(/on-failure|\$\{diagnostics\}/, test["run"])
    # The step's own limit ends a stuck run while the job can still upload its evidence and fail, rather than be
    # cancelled with neither (TAL-670); XCTest's per-test limit names a hung test inside it. The steps after it have
    # short limits of their own, and the failure's result bundles upload ahead of the reports.
    assert_includes(test["run"], "-test-timeouts-enabled YES")
    # Each failing test goes out as a commit status while the job runs, since its log is unreadable until it ends
    # (TAL-673); every caller grants the permission.
    assert_includes(test["run"], 'ci/report-test-failures "${XCODEBUILD_LOG}" "$(git rev-parse HEAD)" "UI suite failures (shard ${SHARD})"')
    assert_includes(test["run"], %q(trap 'kill "${reporter}" 2>/dev/null || true' EXIT))
    assert_includes(test["run"], '[[ "${status}" != 0 ]] || ci/report-test-failures --passed "$(git rev-parse HEAD)" "UI suite failures (shard ${SHARD})"')
    assert_equal("${{ github.token }}", test["env"]["GH_TOKEN"])
    assert_equal("write", shard["permissions"]["statuses"])
    { "ci.yml" => "app", "ui-suite.yml" => "suite", "release-set.yml" => "ui-suite" }.each do |file, job|
      assert_equal("write", workflow_jobs(file).fetch(job)["permissions"]["statuses"], "#{file} #{job}")
    end
    assert_equal("${{ fromJSON(inputs.test_iterations) > 1 && 330 || 45 }}", test["timeout-minutes"])
    assert_equal("${{ fromJSON(inputs.test_iterations) > 1 && 360 || 75 }}", shard["timeout-minutes"])
    after = shard["steps"][(shard["steps"].index(test) + 1)..].take_while { |step| step["name"] }
    assert_equal(["Reject skipped UI tests", "Upload test results on failure"], after.first(2).map { |step| step["name"] })
    after.each { |step| assert(step["timeout-minutes"].to_i.between?(1, 10), "#{step["name"]} has no short limit") }
  end

  def test_failure_alert_covers_a_suite_cancelled_by_a_shard_timeout
    alert = YAML.safe_load_file(File.join(WORKFLOWS, "ui-suite.yml"), aliases: true)["jobs"].fetch("alert")

    # A shard GitHub cancels at its timeout leaves the suite cancelled, not failed, and failure() never ran the alert
    # (TAL-670); ci/ui-suite-failed-jobs keeps a person's cancel from sending anything.
    assert_equal("always() && (needs.suite.result == 'failure' || needs.suite.result == 'cancelled') " \
                 "&& github.ref == 'refs/heads/main' && !inputs.only_testing && (!inputs.ref || inputs.ref == github.sha)",
                 alert["if"])
    assert_equal({"contents" => "read", "actions" => "read", "checks" => "read"}, alert["permissions"])
    post = alert["steps"].find { |step| step["name"] == "Post the signed failure report" }["run"]
    assert_includes(post, 'failed_jobs=$(app/ci/ui-suite-failed-jobs "$GITHUB_RUN_ID")')
    assert_includes(post, 'if [[ "$failed_jobs" == "[]" ]]; then')
  end

  def test_single_worker_runs_on_the_leased_simulator_without_cloning
    script = File.read(File.expand_path("../scripts/test-ios", __dir__))

    # A clone per run races the previous run's clone teardown on the same leased device.
    assert_match(/\(\( TALARIA_TEST_WORKER_COUNT > 1 \)\) && parallel_testing=YES/, script)
    assert_includes(script, '-parallel-testing-enabled "$parallel_testing"')
  end

  def test_pr_ci_uses_a_unique_simulator_destination
    workflow = workflow_text("app-tests.yml")

    # CI boots the image's iPhone 17 with the pinned simulator action and builds for it by name; the local
    # pool, leases and XCTest admission only run in App tooling's own tests.
    jobs = workflow_jobs("app-tests.yml")
    boot = jobs.fetch("app-test")["steps"].find { |step| step["name"] == "Boot the simulator" }
    assert_match(%r{\Afutureware-tech/simulator-action@[0-9a-f]{40}\z}, boot["uses"])
    assert_equal(["iPhone 17", "iOS", "~${{ env.IOS_SIMULATOR_OS }}", false, true, 600],
                 boot["with"].values_at("model", "os", "os_version", "erase_before_boot", "wait_for_boot", "boot_timeout_seconds"))
    assert_includes(workflow, "SIMULATOR_ID: ${{ steps.sim.outputs.udid }}")
    assert_includes(workflow, "BUILD_DESTINATION: platform=iOS Simulator,name=iPhone 17,OS=${{ env.IOS_SIMULATOR_OS }}")
    %w[scripts/select-ios-simulator scripts/test-ios(?![-\w]) scripts/setup-ios-test-pool scripts/ios-simulator-pool(?![-\w])].each do |local|
      refute_match(Regexp.new(local), workflow)
    end
    assert_equal(1, workflow.scan('platform=iOS Simulator,id=${simulator}').length)
    assert_includes(workflow, 'run_tests "${SIMULATOR_ID}" "${RESULT_BUNDLE_PATH}" "${selection[@]}"')
    assert_equal(1, workflow.scan('ci/build-for-testing "${BUILD_DESTINATION}"').length)
    build = File.read(File.expand_path("build-for-testing", __dir__), encoding: "UTF-8")
    assert_includes(build, '-destination "${destination}"')
    refute_includes(workflow, "platform=iOS Simulator,name=${SIMULATOR_NAME}")
  end

  def test_every_workflow_selects_xcode_through_setup_xcode
    # One pin: setup-xcode selects Xcode 27.1 (the iOS 27.1 SDK iPhone Duo layouts need) and exports the newest
    # installed runtime that SDK runs as IOS_SIMULATOR_OS; the hosted image has no iOS 27.1 runtime (TAL-471).
    action = YAML.safe_load_file(File.expand_path("../../.github/actions/setup-xcode/action.yml", __dir__))
    assert_equal("27.1", action["inputs"]["xcode-version"]["default"])
    assert_includes(action["runs"]["steps"].last["run"], 'echo "IOS_SIMULATOR_OS=${simulator_os}" >> "$GITHUB_ENV"')
    Dir[File.join(WORKFLOWS, "*.yml")].each do |path|
      refute_match(/xcode-version|XCODE_VERSION|show-sdk-version/, File.read(path, encoding: "UTF-8"), File.basename(path))
    end
  end

  def test_unit_tests_never_request_real_live_activities
    # A test host that requests real Live Activities leaves them on the simulator,
    # and the next host launch there fails with "No such process" or hangs (TAL-375). The App host installs the real
    # manager; under `swift test` no hook is installed, so only hosted sources and the shared support matter (TAL-399).
    spy = /Spy\w*LiveActivityManager/
    hosted = %w[../TalariaTests/**/*.swift ../TalariaKit/Tests/TalariaKitTests/Support/**/*.swift]
    constructions = hosted.flat_map { |pattern| Dir[File.expand_path(pattern, __dir__)] }.flat_map do |path|
      source = File.read(path, encoding: "UTF-8")
      source.enum_for(:scan, /^(\s*)(?:let \w+ = |return )ChatViewModel\((.*?)\n\1\)/m).map do
        match = Regexp.last_match
        enclosing_function = source[0...match.begin(0)][/.*\bfunc .*/m].to_s.split(/\bfunc /).last.to_s
        [File.basename(path), enclosing_function, match[2][/liveActivityManager: ([^,\n]+)/, 1]]
      end
    end

    assert_operator(constructions.length, :>=, 2)
    constructions.each do |file, enclosing_function, manager|
      # A nil or omitted manager resolves to the shared production manager.
      test_double = manager&.match?(/\A(?:liveActivityManager \?\? )?#{spy}\(\)\z/) ||
        (manager&.match?(/\A\w+\z/) && enclosing_function.match?(/\b#{manager}(?: = |: )#{spy}\b/))
      assert(test_double, "#{file} builds a ChatViewModel with #{manager || "the default"} Live Activity manager")
    end

    workflow = workflow_text("app-tests.yml")
    suite_step = workflow[/- name: Test without building.*?(?=\n      - name: )/m]
    # No erase between runs works around a test host's leftover state (TAL-375); the step only boots and shuts down
    # simulators so that one runs at a time (TAL-669).
    refute_includes(suite_step, "xcrun simctl erase")
  end

  def test_hosted_shards_boot_before_waiting_for_the_build
    jobs = workflow_jobs("app-tests.yml")
    shard = jobs.fetch("app-test")
    # Test jobs queue once App build holds a runner, never beside a queued build (TAL-413), and boot their simulator
    # while it builds (TAL-380). The wait runs on Linux, so it holds no macOS slot.
    assert_equal("build-started", shard["needs"])
    started = jobs.fetch("build-started")
    assert_equal(["inputs.mode == 'full'", "ubuntu-latest"], started.values_at("if", "runs-on"))
    assert_equal(['ci/wait-for-job "${BUILD_JOB}" 20700 "Set up job"'], started["steps"].filter_map { |step| step["run"] })
    # The boot finishes before the build wait and download, so it competes with neither (TAL-380), and the simulator
    # is prepared while the build still runs (scripts/prepare-ui-simulator: the keyboard introduction, TAL-668;
    # notifications, TAL-651; a photo, TAL-633).
    boot = shard["steps"].index { |step| step["name"] == "Boot the simulator" }
    assert_equal('scripts/prepare-ui-simulator "${{ steps.sim.outputs.udid }}"', shard["steps"][boot + 1]["run"])
    assert_equal(["Prepare the simulator", "Wait for the build", "Download the test build", "Select this shard's tests",
                  "Test without building"],
                 shard["steps"][boot + 1, 5].map { |step| step["name"] })
    assert_equal("true", shard["steps"][boot]["with"]["wait_for_boot"].to_s)
    refute(shard["steps"].any? { |step| step["name"] == "Build for testing" }, "test jobs never build")
    steps = shard["steps"].map { |step| [step["name"] || step["uses"], step] }.to_h
    assert_equal(1, workflow_text("app-tests.yml").scan("xcodebuild test-without-building").length)
    # The build poll starts in the background before the setup and the boot, whose aftermath starves this runner,
    # and the step after the boot collects its result (TAL-405).
    start = shard["steps"].index { |step| step["name"] == "Start waiting for the build" }
    assert_equal(["actions/checkout@v7", "./.github/actions/setup-xcode"], [start - 1, start + 1].map { |index| shard["steps"][index]["uses"] })
    assert_includes(steps.fetch("Start waiting for the build")["run"],
                    %(nohup bash -c 'ci/wait-for-job "${BUILD_JOB}" 2700 "Upload the test build"; echo $? >))
    assert_includes(steps.fetch("Wait for the build")["run"], 'exit "$(cat "${status}")"')
    # Every native contract class and the live test run in the package job; hosted shards never read the probe's
    # fixture (TAL-399).
    refute_match(/contract-fixture|LIVE_CONTRACT|CONTRACT_TEST_CLASSES|CONTRACTS_SELECTED/, shard.to_yaml)
  end

  def test_hosted_shards_record_memory_on_every_run
    # A hosted runner once swapped until every UI query timed out (TAL-419); every shard keeps its memory samples.
    steps = workflow_jobs("app-tests.yml").fetch("app-test")["steps"].map { |step| [step["name"], step] }.to_h
    suite = steps.fetch("Test without building")["run"]
    assert_includes(suite, 'nohup ci/memory-sampler watch "${MEMORY_LOG}" "${XCODEBUILD_LOG}"')
    assert_includes(suite, "set -euo pipefail")
    assert_includes(suite, '"$@" 2>&1 | tee -a "${XCODEBUILD_LOG}"')
    report, upload = steps.values_at("Report memory", "Upload memory samples")
    assert_equal(["always()"] * 2, [report, upload].map { |step| step["if"] })
    assert_includes(report["run"], 'ci/memory-sampler summary "${MEMORY_LOG}" | tee -a "${GITHUB_STEP_SUMMARY}"')
    assert_equal("app/${{ env.MEMORY_LOG }}", upload["with"]["path"])
  end

  def test_package_job_runs_the_live_test_without_a_simulator
    package, probe = workflow_jobs("app-tests.yml").fetch("package-test"), workflow_jobs("ci.yml").fetch("contracts")
    # TalariaKit's tests run with `swift test` on hosted macOS beside the build: no simulator, no app host (TAL-399).
    assert_nil(package["needs"])
    # Every caller runs it but a release's UI suite call, whose contracts job runs the same suite (TAL-414).
    assert_equal("inputs.package_tests", package["if"])
    assert_equal({"type" => "boolean", "default" => true},
                 YAML.safe_load_file(File.join(WORKFLOWS, "app-tests.yml"), aliases: true)[true]["workflow_call"]["inputs"]["package_tests"])
    assert_equal("xcode-27", package["runs-on"])
    refute_match(/simulator|xcodebuild/i, package.to_yaml)
    steps = package["steps"].map { |step| [step["name"] || step["uses"], step] }.to_h
    names = steps.keys
    assert_equal("./.github/actions/setup-xcode", names[1])
    build, wait, fetch, suite = ["Build the package tests", "Wait for the Web contract probe",
                                 "Download the probe's live response fixture", "Test the package"].map { |name| names.index(name) }
    assert_equal([build + 1, build + 2, build + 3], [wait, fetch, suite])
    assert_includes(steps.fetch(names[build])["run"], "--only-use-versions-from-resolved-file")
    [wait, fetch].each { |index| assert_equal("env.CONTRACTS_SELECTED == 'true'", package["steps"][index]["if"]) }
    # "Re-run failed jobs" keeps an earlier probe, so the newest attempt at or before this one is awaited.
    assert_equal('ci/wait-for-job "Web contract probe" 1500', steps.fetch(names[wait])["run"])
    waiter = File.read(File.expand_path("wait-for-job", __dir__), encoding: "UTF-8")
    ["filter=all", ".run_attempt <= ($ENV.GITHUB_RUN_ATTEMPT | tonumber)", "(.name == $ENV.WAIT_JOB_NAME or"]
      .each { |required| assert_includes(waiter, required) }
    assert_equal("contract-fixture", steps.fetch(names[fetch])["with"]["name"])
    # A missing fixture makes the live test skip, so the job requires its explicit pass.
    ['export TALARIA_LIVE_CONTRACT_RESPONSES="${fixture}"', "swift test --package-path TalariaKit --skip-build",
     %(grep -qF -- "Test Case '-[${LIVE_CONTRACT_TEST}]' passed" package-tests.log)]
      .each { |required| assert_includes(steps.fetch(names[suite])["run"], required) }
    assert_equal("TalariaKitTests.APIClientSessionListTests testLiveUpstreamContractResponsesDecodeWhenSupplied",
                 package["env"]["LIVE_CONTRACT_TEST"])
    live_test = File.read(File.expand_path("../TalariaKit/Tests/TalariaKitTests/APIClientSessionListTests.swift", __dir__),
                          encoding: "UTF-8")
    assert_includes(live_test, "func testLiveUpstreamContractResponsesDecodeWhenSupplied()")
    upload = probe["steps"].find { |step| step["uses"].to_s.start_with?("actions/upload-artifact@") }
    assert_equal("contract-fixture", upload["with"]["name"])
  end

  def test_package_pins_match_the_app
    # `swift test` resolves from TalariaKit's own Package.resolved; it must build the revisions the App ships.
    pins = lambda do |path|
      JSON.parse(File.read(File.expand_path(path, __dir__))).fetch("pins").to_h { |pin| [pin["identity"], pin["state"]] }
    end
    package = pins.call("../TalariaKit/Package.resolved")
    app = pins.call("../Talaria.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved")
    refute_empty(package)
    package.each { |identity, state| assert_equal(app.fetch(identity), state, identity) }
  end

  def test_pr_ci_shards_run_one_worker_without_clones
    workflow = workflow_text("app-tests.yml")
    shards = File.read(File.expand_path("test_shards.py", __dir__), encoding: "UTF-8")

    # Every run uses one worker on the job's own booted simulator: clones took minutes to boot on hosted runners.
    assert_equal(1, workflow.scan("            -parallel-testing-enabled NO \\").length)
    refute_match(/parallel-testing-enabled YES|parallel-testing-worker-count|test_workers|build_cache|COMPILATION_CACHE|xcode-cache/, workflow)
    refute_match(/COMPILATION_CACHE|build-cache/, File.read(File.expand_path("build-for-testing", __dir__), encoding: "UTF-8"))
    # Pull requests run the package tests and the App build for testing, and nothing in a simulator (TAL-405). The
    # simulator-hosted unit tests, the launch smoke and every UI test run in the full suite's four shards
    # (TAL-399), or in one for a scoped UI suite dispatch (TAL-401).
    assert_includes(workflow, "timeout-minutes: ${{ fromJSON(inputs.test_iterations) > 1 && 360 || 75 }}")
    # Dispatch inputs arrive as strings, so the reusable workflow's input is a string too.
    app_tests = YAML.safe_load_file(File.join(WORKFLOWS, "app-tests.yml"), aliases: true)
    assert_equal({"type" => "string", "default" => "1"}, app_tests[true]["workflow_call"]["inputs"]["test_iterations"])
    assert_includes(workflow, 'if (( TEST_ITERATIONS > 1 )); then set -- "$@" -test-iterations "${TEST_ITERATIONS}" -run-tests-until-failure; fi')
    jobs = workflow_jobs("app-tests.yml")
    shard = jobs.fetch("app-test")
    # inputs.shards shards (default four; a release passes its own count, TAL-414), or one for a scoped dispatch.
    assert_equal("${{ inputs.only_testing == '' && fromJSON('[null,[0],[0,1],[0,1,2],[0,1,2,3],[0,1,2,3,4],[0,1,2,3,4,5]]')[inputs.shards] || fromJSON('[0]') }}",
                 shard["strategy"]["matrix"]["shard"])
    assert_equal({"type" => "number", "default" => 4}, app_tests[true]["workflow_call"]["inputs"]["shards"])
    # A pull request builds without a test shard; a contract-only change has no App build either, and the package
    # job runs its contract classes in every mode.
    assert_equal("inputs.mode == 'full'", shard["if"])
    assert_equal("inputs.mode != 'contracts'", jobs.fetch("app-build")["if"])
    assert_equal([nil] * 2, jobs.values_at("app-build", "package-test").map { |job| job["needs"] })
    # Only the full suite packages and uploads its build for the shards; the build itself always runs to the end.
    build_steps = jobs.fetch("app-build")["steps"].map { |step| [step["name"] || step["uses"], step] }.to_h
    assert_equal(["inputs.mode == 'full'"] * 2, build_steps.values_at("Package the test build", "Upload the test build").map { |step| step["if"] })
    assert_equal('ci/build-for-testing "${BUILD_DESTINATION}"', build_steps.fetch("Build for testing")["run"])
    assert_nil(build_steps.fetch("Build for testing")["if"])
    # The launch smoke runs as one of the full suite's UI tests, and no UI test may skip.
    refute_match(/LAUNCH_SMOKE|require-launch-smoke|MODE/, shard.to_yaml)
    reject = shard["steps"].find { |step| step["name"] == "Reject skipped UI tests" }["run"]
    # Classes that need an iPad or a Pro Max run on one after the shard's own tests (test_shards.py's DEVICE_CLASSES,
    # TAL-471), and must not skip there either.
    assert_includes(reject, 'for bundle in "${RESULT_BUNDLE_PATH}" DestinationResults-*.xcresult; do')
    assert_includes(reject, '[[ ! -e "${bundle}" ]] || scripts/assert-no-skipped-ui-tests "${bundle}"')
    select = shard["steps"].find { |step| step["name"] == "Select this shard's tests" }["run"]
    assert_includes(select, 'python3 ci/test_shards.py --shards "${SHARD_COUNT}" --shard "${SHARD}" --devices --runtime "${runtime}" > devices.txt')
    assert_includes(select, 'python3 ci/test_shards.py --devices --runtime "${runtime}" --only-testing ${ONLY_TESTING} > devices.txt')
    test = shard["steps"].find { |step| step["name"] == "Test without building" }["run"]
    assert_includes(test, 'run_tests "${device}" "DestinationResults-${index}.xcresult" "${options[@]}" < /dev/null || status=$?')
    # One simulator at a time, booted once: the shard's own one shuts down before its destination runs, and each
    # destination boots fully, and is prepared, before its tests and shuts down after them (TAL-669); the boot
    # action then leaves its device alone.
    assert_includes(test, 'scripts/prepare-ui-simulator --keyboard-only "${device}" < /dev/null')
    assert_includes(test, '[[ ! -s devices.txt ]] || xcrun simctl shutdown "${SIMULATOR_ID}"')
    assert_includes(test, 'xcrun simctl bootstatus "${device}" -b > /dev/null < /dev/null')
    assert_includes(test, 'xcrun simctl shutdown "${device}" < /dev/null')
    assert_equal(false, shard["steps"].find { |step| step["name"] == "Boot the simulator" }["with"]["shutdown_after_job"])
    # A failing shard still runs its destination classes, and the step still fails.
    assert_includes(test, 'run_tests "${SIMULATOR_ID}" "${RESULT_BUNDLE_PATH}" "${selection[@]}" || status=$?')
    assert_match(/exit "\$\{status\}"\n\z/, test)
    # Pull requests and main pushes run the same App jobs; the full UI suite, launch smoke included, is nightly and
    # a release gate.
    app = workflow_jobs("ci.yml").fetch("app")
    assert_equal("./.github/workflows/app-tests.yml", app["uses"])
    assert_equal("${{ (needs.changes.result != 'success' || needs.changes.outputs.app != 'false') && 'pull-request' || 'contracts' }}",
                 app["with"]["mode"])
    refute_match(/full_ui|mode: full/, workflow_text("ci.yml"))
    suite = YAML.safe_load_file(File.join(WORKFLOWS, "ui-suite.yml"), aliases: true)
    assert_equal({"mode" => "full", "ref" => "${{ inputs.ref }}", "only_testing" => "${{ inputs.only_testing }}",
                  "test_iterations" => "${{ inputs.test_iterations || '1' }}"}, suite["jobs"]["suite"]["with"])
    assert_equal("string", suite[true]["workflow_dispatch"]["inputs"]["test_iterations"]["type"])
    # A release calls app-tests.yml directly: a called ui-suite.yml's concurrency left its jobs pending (TAL-417).
    assert_equal(%w[schedule workflow_dispatch], suite[true].keys)
    assert_includes(workflow, 'python3 ci/test_shards.py --shards "${SHARD_COUNT}" --shard "${SHARD}" > selection.txt')
    # CI skips the measurement-only UI classes and the scheduled UI Performance
    # workflow runs them (TAL-75, TAL-287); the shard script owns the skip list.
    %w[
      SidebarPerformanceUITests
      LaunchPerformanceUITests
      TranscriptPerformanceUITests
      NavigationPerformanceUITests
    ].each do |performance_class|
      assert_includes(shards, "TalariaUITests/#{performance_class}")
    end
    assert_includes(workflow, "scripts/report-performance-metrics")
    reporter = File.read(File.expand_path("../scripts/report-performance-metrics", __dir__), encoding: "UTF-8")
    assert_includes(reporter, '"xcresulttool", "get", "test-results", "metrics"')
  end
end
