#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require "yaml"

class TestIOSRunnerTest < Minitest::Test
  def test_disables_slow_xcode_failure_diagnostics
    script = File.read(File.expand_path("../scripts/test-ios", __dir__))

    assert_includes(script, "-collect-test-diagnostics never")
  end

  def test_single_worker_runs_on_the_leased_simulator_without_cloning
    script = File.read(File.expand_path("../scripts/test-ios", __dir__))

    # A clone per run races the previous run's clone teardown on the same leased device.
    assert_match(/\(\( TALARIA_TEST_WORKER_COUNT > 1 \)\) && parallel_testing=YES/, script)
    assert_includes(script, '-parallel-testing-enabled "$parallel_testing"')
  end

  def test_pr_ci_uses_a_unique_simulator_destination
    workflow = File.read(
      File.expand_path("../../.github/workflows/ci.yml", __dir__),
      encoding: "UTF-8"
    )

    # CI boots the image's iPhone 17 with the pinned simulator action and builds for it by name; the local
    # pool, leases and XCTest admission only run in App tooling's own tests.
    jobs = YAML.safe_load_file(File.expand_path("../../.github/workflows/ci.yml", __dir__), aliases: true)["jobs"]
    boot = jobs.fetch("app-test")["steps"].find { |step| step["name"] == "Boot the simulator" }
    assert_match(%r{\Afutureware-tech/simulator-action@[0-9a-f]{40}\z}, boot["uses"])
    assert_equal(["iPhone 17", "iOS", "~${{ env.XCODE_VERSION }}", false, true, 600],
                 boot["with"].values_at("model", "os", "os_version", "erase_before_boot", "wait_for_boot", "boot_timeout_seconds"))
    assert_includes(workflow, "SIMULATOR_ID: ${{ steps.sim.outputs.udid }}")
    assert_includes(workflow, "BUILD_DESTINATION: platform=iOS Simulator,name=iPhone 17,OS=${{ env.XCODE_VERSION }}")
    %w[scripts/select-ios-simulator scripts/test-ios(?![-\w]) scripts/setup-ios-test-pool scripts/ios-simulator-pool(?![-\w])].each do |local|
      refute_match(Regexp.new(local), workflow)
    end
    assert_equal(1, workflow.scan('platform=iOS Simulator,id=${SIMULATOR_ID}').length)
    assert_equal(1, workflow.scan('ci/build-for-testing "${BUILD_DESTINATION}"').length)
    build = File.read(File.expand_path("build-for-testing", __dir__), encoding: "UTF-8")
    assert_includes(build, '-destination "${destination}"')
    refute_includes(workflow, "platform=iOS Simulator,name=${SIMULATOR_NAME}")
  end

  def test_unit_tests_never_request_real_live_activities
    # A test host that requests real Live Activities leaves them on the simulator,
    # and the next host launch there fails with "No such process" or hangs (TAL-375).
    spy = /Spy\w*LiveActivityManager/
    constructions = Dir[File.expand_path("../TalariaTests/**/*.swift", __dir__)].flat_map do |path|
      source = File.read(path, encoding: "UTF-8")
      source.enum_for(:scan, /^(\s*)(?:let \w+ = |return )ChatViewModel\((.*?)\n\1\)/m).map do
        match = Regexp.last_match
        enclosing_function = source[0...match.begin(0)][/.*\bfunc .*/m].to_s.split(/\bfunc /).last.to_s
        [File.basename(path), enclosing_function, match[2][/liveActivityManager: ([^,\n]+)/, 1]]
      end
    end

    assert_operator(constructions.length, :>=, 10)
    constructions.each do |file, enclosing_function, manager|
      # A nil or omitted manager resolves to the shared production manager.
      test_double = manager&.match?(/\A(?:liveActivityManager \?\? )?#{spy}\(\)\z/) ||
        (manager&.match?(/\A\w+\z/) && enclosing_function.match?(/\b#{manager}(?: = |: )#{spy}\b/))
      assert(test_double, "#{file} builds a ChatViewModel with #{manager || "the default"} Live Activity manager")
    end

    workflow = File.read(File.expand_path("../../.github/workflows/ci.yml", __dir__), encoding: "UTF-8")
    suite_step = workflow[/- name: Test without building.*?(?=\n      - name: )/m]
    refute_includes(suite_step, "xcrun simctl")
  end

  def test_only_shard_zero_runs_the_live_test_inside_its_suite
    jobs = YAML.safe_load_file(File.expand_path("../../.github/workflows/ci.yml", __dir__), aliases: true)["jobs"]
    shard, probe = jobs.fetch("app-test"), jobs.fetch("contracts")
    # Test jobs start with App build and boot their simulator while it builds; shard 0 fetches the Linux
    # probe's fixture before its suite and runs the live decoding test in the same xcodebuild (TAL-380).
    assert_equal("changes", shard["needs"])
    # The boot finishes before the build wait and download, so it competes with neither (TAL-380).
    boot = shard["steps"].index { |step| step["name"] == "Boot the simulator" }
    assert_equal(["Wait for App build", "Download the test build"], shard["steps"][boot + 1, 2].map { |step| step["name"] })
    assert_equal("true", shard["steps"][boot]["with"]["wait_for_boot"].to_s)
    refute(shard["steps"].any? { |step| step["name"] == "Build for testing" }, "test jobs never build")
    steps = shard["steps"].map { |step| [step["name"] || step["uses"], step] }.to_h
    names = steps.keys
    download, wait, fetch, select, suite = [
      "Download the test build", "Wait for the Web contract probe", "Download the probe's live response fixture",
      "Select this shard's tests", "Test without building"
    ].map { |name| names.index(name) }
    assert_equal([download + 1, download + 2, download + 3, download + 4], [wait, fetch, select, suite])
    refute(names.any? { |name| name.to_s.include?("Run the live Web contract test") }, "no second xcodebuild")
    [wait, fetch].each do |index|
      assert_equal("env.CONTRACTS_SELECTED == 'true' && matrix.shard == 0", shard["steps"][index]["if"])
    end
    # "Re-run failed jobs" keeps an earlier probe, so the newest attempt at or before this one is awaited.
    assert_equal('ci/wait-for-job "Web contract probe" 1500', steps.fetch(names[wait])["run"])
    waiter = File.read(File.expand_path("wait-for-job", __dir__), encoding: "UTF-8")
    ["filter=all", ".run_attempt <= ($ENV.GITHUB_RUN_ATTEMPT | tonumber)", "select(.name == $ENV.WAIT_JOB_NAME"]
      .each { |required| assert_includes(waiter, required) }
    assert_equal("contract-fixture", steps.fetch(names[fetch])["with"]["name"])
    ['export TEST_RUNNER_TALARIA_LIVE_CONTRACT_RESPONSES="${fixture}"', '.[0].result == "Passed"',
     '[[ "${CONTRACTS_SELECTED}" == "true" && "${SHARD}" == "0" ]] && live=true']
      .each { |required| assert_includes(steps.fetch(names[suite])["run"], required) }
    # The selection drops only the live test's skip, and only in shard 0 with contracts selected.
    assert_includes(steps.fetch(names[select])["run"], 'grep -vx -- "-skip-testing:${LIVE_CONTRACT_TEST}" selection.txt')
    assert_equal(1, File.read(File.expand_path("../../.github/workflows/ci.yml", __dir__)).scan("xcodebuild test-without-building").length)
    upload = probe["steps"].find { |step| step["uses"].to_s.start_with?("actions/upload-artifact@") }
    assert_equal("contract-fixture", upload["with"]["name"])
    # The shard script skips the live test everywhere else.
    assert_includes(File.read(File.expand_path("test_shards.py", __dir__), encoding: "UTF-8"),
                    "TalariaTests/APIClientSessionListTests/testLiveUpstreamContractResponsesDecodeWhenSupplied")
  end

  def test_pr_ci_shards_run_one_worker_without_clones
    workflow = File.read(
      File.expand_path("../../.github/workflows/ci.yml", __dir__),
      encoding: "UTF-8"
    )
    shards = File.read(File.expand_path("test_shards.py", __dir__), encoding: "UTF-8")
    ui_tests = File.read(
      File.expand_path("../TalariaUITests/TalariaUITests.swift", __dir__),
      encoding: "UTF-8"
    )

    # Every run uses one worker on the job's own booted simulator: clones took minutes to boot on hosted runners.
    assert_equal(1, workflow.scan("            -parallel-testing-enabled NO \\").length)
    refute_match(/parallel-testing-enabled YES|parallel-testing-worker-count|test_workers|build_cache|COMPILATION_CACHE|xcode-cache/, workflow)
    refute_match(/COMPILATION_CACHE|build-cache/, File.read(File.expand_path("build-for-testing", __dir__), encoding: "UTF-8"))
    # Four shards for the full suite, otherwise one test job; App build runs whenever any test job does.
    full = "(github.event_name == 'push' || inputs.full_ui == true) && (needs.changes.result != 'success' || needs.changes.outputs.app != 'false')"
    app = "(needs.changes.result != 'success' || needs.changes.outputs.app != 'false')"
    assert_includes(workflow, "shard: ${{ fromJSON((#{full}) && '[0,1,2,3]' || (#{app} && '[0,1]' || '[0]')) }}")
    jobs = YAML.safe_load_file(File.expand_path("../../.github/workflows/ci.yml", __dir__), aliases: true)["jobs"]
    assert_equal(jobs["app-test"]["if"], jobs["app-build"]["if"])
    assert_equal("changes", jobs["app-build"]["needs"])
    assert_includes(workflow, 'python3 ci/test_shards.py "${options[@]}" > selection.txt')
    assert_equal(26, ui_tests.scan(/final class \w+UITests: \w+UITestCase/).length)
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
