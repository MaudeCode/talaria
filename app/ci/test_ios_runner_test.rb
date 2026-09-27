#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"

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
      File.expand_path("../../.github/workflows/pr-ci.yml", __dir__),
      encoding: "UTF-8"
    )

    assert_includes(workflow, 'selected["udid"]')
    assert_equal(3, workflow.scan('platform=iOS Simulator,id=${SIMULATOR_ID}').length)
    refute_includes(workflow, "platform=iOS Simulator,name=${SIMULATOR_NAME}")
  end

  def test_unit_tests_never_request_real_live_activities
    # A test host that requests real Live Activities leaves them on the simulator,
    # and the next host launch there fails with "No such process" or hangs (TAL-375).
    constructions = Dir[File.expand_path("../TalariaTests/**/*.swift", __dir__)].flat_map do |path|
      File.read(path, encoding: "UTF-8").scan(/^(\s*)(?:let \w+ = |return )ChatViewModel\((.*?)\n\1\)/m).map do |_, arguments|
        [File.basename(path), arguments]
      end
    end

    assert_operator(constructions.length, :>=, 10)
    constructions.each do |file, arguments|
      assert_match(/liveActivityManager: \S/, arguments, "#{file} builds a ChatViewModel with the real Live Activity manager")
    end
    support = File.read(File.expand_path("../TalariaTests/ChatViewModelSendTests+Support.swift", __dir__), encoding: "UTF-8")
    assert_includes(support, "liveActivityManager: liveActivityManager ?? SpyChatLiveActivityManager(),")

    workflow = File.read(File.expand_path("../../.github/workflows/pr-ci.yml", __dir__), encoding: "UTF-8")
    live_step = workflow[/- name: Run the live Web contract test.*?(?=\n      - name: )/m]
    refute_includes(live_step, "xcrun simctl")
  end

  def test_pr_ci_runs_pr_smoke_without_clones_and_main_ui_with_two_workers
    workflow = File.read(
      File.expand_path("../../.github/workflows/pr-ci.yml", __dir__),
      encoding: "UTF-8"
    )
    scheme = File.read(
      File.expand_path("../Talaria.xcodeproj/xcshareddata/xcschemes/Talaria.xcscheme", __dir__),
      encoding: "UTF-8"
    )
    ui_tests = File.read(
      File.expand_path("../TalariaUITests/TalariaUITests.swift", __dir__),
      encoding: "UTF-8"
    )

    ui_testable = scheme.scan(/<TestableReference.*?<\/TestableReference>/m).find do |testable|
      testable.include?('BlueprintName = "TalariaUITests"')
    end

    assert_includes(workflow, "TEST_WORKER_COUNT: ${{ github.event_name == 'pull_request' && 1 || 2 }}")
    assert_includes(workflow, "(( TEST_WORKER_COUNT > 1 )) && parallel_testing=YES")
    assert_includes(workflow, '-parallel-testing-enabled "${parallel_testing}"')
    assert_includes(ui_testable, 'parallelizable = "YES"')
    assert_equal(26, ui_tests.scan(/final class \w+UITests: \w+UITestCase/).length)
    # CI skips the measurement-only UI classes and the scheduled UI Performance
    # workflow runs them (TAL-75, TAL-287); the list is one env var in pr-ci.
    %w[
      SidebarPerformanceUITests
      LaunchPerformanceUITests
      TranscriptPerformanceUITests
      NavigationPerformanceUITests
    ].each do |performance_class|
      assert_includes(workflow, "TalariaUITests/#{performance_class}")
    end
    assert_includes(workflow, '-skip-testing:${performance_class}')
    assert_includes(workflow, "scripts/report-performance-metrics")
    reporter = File.read(File.expand_path("../scripts/report-performance-metrics", __dir__), encoding: "UTF-8")
    assert_includes(reporter, '"xcresulttool", "get", "test-results", "metrics"')
  end
end
