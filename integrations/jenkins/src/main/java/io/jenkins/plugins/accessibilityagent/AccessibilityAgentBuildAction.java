package io.jenkins.plugins.accessibilityagent;

import hudson.model.Action;
import hudson.model.Run;
import jenkins.model.RunAction2;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;

/**
 * Build action that stores accessibility test results and provides the dashboard view.
 */
public class AccessibilityAgentBuildAction implements RunAction2, Serializable {
    private static final long serialVersionUID = 2L;

    private transient Run<?, ?> run;
    private final List<AccessibilityTestResult> results;
    private final long totalDurationMs;
    private String dashboardUrl;
    private String dashboardTestRunId;

    public AccessibilityAgentBuildAction(List<AccessibilityTestResult> results, long totalDurationMs) {
        this.results = results != null ? results : new ArrayList<>();
        this.totalDurationMs = totalDurationMs;
    }

    public void setDashboardInfo(String dashboardUrl, String testRunId) {
        this.dashboardUrl = dashboardUrl;
        this.dashboardTestRunId = testRunId;
    }

    public String getDashboardUrl() {
        return dashboardUrl;
    }

    public String getDashboardTestRunId() {
        return dashboardTestRunId;
    }

    public String getDashboardResultsUrl() {
        if (dashboardUrl == null || dashboardTestRunId == null) {
            return null;
        }
        String baseUrl = dashboardUrl.endsWith("/") ? dashboardUrl : dashboardUrl + "/";
        return baseUrl + "runs/" + dashboardTestRunId;
    }

    public boolean hasDashboardResults() {
        return dashboardUrl != null && dashboardTestRunId != null;
    }

    @Override
    public void onAttached(Run<?, ?> run) {
        this.run = run;
    }

    @Override
    public void onLoad(Run<?, ?> run) {
        this.run = run;
    }

    public Run<?, ?> getRun() {
        return run;
    }

    @Override
    public String getIconFileName() {
        return "symbol-accessibility plugin-ionicons-api";
    }

    @Override
    public String getDisplayName() {
        return "Accessibility Test Results";
    }

    @Override
    public String getUrlName() {
        return "accessibility-results";
    }

    public List<AccessibilityTestResult> getResults() {
        return results;
    }

    public int getTotalTests() {
        return results.size();
    }

    public int getPassedTests() {
        return (int) results.stream().filter(AccessibilityTestResult::isSuccess).count();
    }

    public int getFailedTests() {
        return (int) results.stream().filter(r -> !r.isSuccess()).count();
    }

    public double getPassRate() {
        if (results.isEmpty()) {
            return 0.0;
        }
        return (double) getPassedTests() / getTotalTests() * 100;
    }

    public String getFormattedPassRate() {
        return String.format("%.1f%%", getPassRate());
    }

    public long getTotalDurationMs() {
        return totalDurationMs;
    }

    public String getFormattedTotalDuration() {
        long seconds = totalDurationMs / 1000;
        long minutes = seconds / 60;
        seconds = seconds % 60;
        if (minutes > 0) {
            return String.format("%dm %ds", minutes, seconds);
        }
        return String.format("%ds", seconds);
    }

    public int getTotalViolations() {
        return results.stream()
                .mapToInt(r -> r.getViolations().size())
                .sum();
    }

    public int getTotalSteps() {
        return results.stream()
                .mapToInt(AccessibilityTestResult::getStepCount)
                .sum();
    }

    public String getOverallStatus() {
        return getFailedTests() == 0 ? "PASSED" : "FAILED";
    }

    public String getOverallStatusClass() {
        return getFailedTests() == 0 ? "success" : "failure";
    }

    /**
     * Get results grouped by success status for easier display
     */
    public List<AccessibilityTestResult> getFailedResults() {
        List<AccessibilityTestResult> failed = new ArrayList<>();
        for (AccessibilityTestResult result : results) {
            if (!result.isSuccess()) {
                failed.add(result);
            }
        }
        return failed;
    }

    public List<AccessibilityTestResult> getPassedResults() {
        List<AccessibilityTestResult> passed = new ArrayList<>();
        for (AccessibilityTestResult result : results) {
            if (result.isSuccess()) {
                passed.add(result);
            }
        }
        return passed;
    }
}
