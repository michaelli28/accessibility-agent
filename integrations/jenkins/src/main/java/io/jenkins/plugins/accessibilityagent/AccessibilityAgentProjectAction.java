package io.jenkins.plugins.accessibilityagent;

import hudson.model.Action;
import hudson.model.Job;
import hudson.model.Run;

import java.util.ArrayList;
import java.util.List;

/**
 * Project-level action that shows accessibility test trends across builds.
 */
public class AccessibilityAgentProjectAction implements Action {

    private final Job<?, ?> project;

    public AccessibilityAgentProjectAction(Job<?, ?> project) {
        this.project = project;
    }

    @Override
    public String getIconFileName() {
        return "symbol-accessibility plugin-ionicons-api";
    }

    @Override
    public String getDisplayName() {
        return "Accessibility Trends";
    }

    @Override
    public String getUrlName() {
        return "accessibility-trends";
    }

    public Job<?, ?> getProject() {
        return project;
    }

    /**
     * Get the last N builds with accessibility results for trend display.
     */
    public List<BuildSummary> getRecentBuilds(int count) {
        List<BuildSummary> summaries = new ArrayList<>();
        Run<?, ?> run = project.getLastBuild();

        while (run != null && summaries.size() < count) {
            AccessibilityAgentBuildAction action = run.getAction(AccessibilityAgentBuildAction.class);
            if (action != null) {
                summaries.add(new BuildSummary(
                        run.getNumber(),
                        run.getDisplayName(),
                        action.getTotalTests(),
                        action.getPassedTests(),
                        action.getFailedTests(),
                        action.getPassRate(),
                        action.getTotalViolations()
                ));
            }
            run = run.getPreviousBuild();
        }

        return summaries;
    }

    public List<BuildSummary> getRecentBuilds() {
        return getRecentBuilds(20);
    }

    /**
     * Get the latest build action for quick access.
     */
    public AccessibilityAgentBuildAction getLatestAction() {
        Run<?, ?> run = project.getLastBuild();
        while (run != null) {
            AccessibilityAgentBuildAction action = run.getAction(AccessibilityAgentBuildAction.class);
            if (action != null) {
                return action;
            }
            run = run.getPreviousBuild();
        }
        return null;
    }

    /**
     * Summary data for a single build, used for trend visualization.
     */
    public static class BuildSummary {
        private final int buildNumber;
        private final String displayName;
        private final int totalTests;
        private final int passedTests;
        private final int failedTests;
        private final double passRate;
        private final int violations;

        public BuildSummary(int buildNumber, String displayName, int totalTests,
                           int passedTests, int failedTests, double passRate, int violations) {
            this.buildNumber = buildNumber;
            this.displayName = displayName;
            this.totalTests = totalTests;
            this.passedTests = passedTests;
            this.failedTests = failedTests;
            this.passRate = passRate;
            this.violations = violations;
        }

        public int getBuildNumber() {
            return buildNumber;
        }

        public String getDisplayName() {
            return displayName;
        }

        public int getTotalTests() {
            return totalTests;
        }

        public int getPassedTests() {
            return passedTests;
        }

        public int getFailedTests() {
            return failedTests;
        }

        public double getPassRate() {
            return passRate;
        }

        public String getFormattedPassRate() {
            return String.format("%.1f%%", passRate);
        }

        public int getViolations() {
            return violations;
        }
    }
}
