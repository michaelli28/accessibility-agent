package io.jenkins.plugins.accessibilityagent;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;

/**
 * Represents the result of a single accessibility test run.
 */
public class AccessibilityTestResult implements Serializable {
    private static final long serialVersionUID = 1L;

    private final String url;
    private final String goal;
    private final boolean success;
    private final String reason;
    private final String error;
    private final int stepCount;
    private final List<TestStep> steps;
    private final List<Violation> violations;
    private final long durationMs;

    public AccessibilityTestResult(String url, String goal, boolean success, String reason,
                                   String error, int stepCount, List<TestStep> steps,
                                   List<Violation> violations, long durationMs) {
        this.url = url;
        this.goal = goal;
        this.success = success;
        this.reason = reason;
        this.error = error;
        this.stepCount = stepCount;
        this.steps = steps != null ? steps : new ArrayList<>();
        this.violations = violations != null ? violations : new ArrayList<>();
        this.durationMs = durationMs;
    }

    public String getUrl() {
        return url;
    }

    public String getGoal() {
        return goal;
    }

    public boolean isSuccess() {
        return success;
    }

    public String getReason() {
        return reason;
    }

    public String getError() {
        return error;
    }

    public int getStepCount() {
        return stepCount;
    }

    public List<TestStep> getSteps() {
        return steps;
    }

    public List<Violation> getViolations() {
        return violations;
    }

    public long getDurationMs() {
        return durationMs;
    }

    public String getFormattedDuration() {
        long seconds = durationMs / 1000;
        long minutes = seconds / 60;
        seconds = seconds % 60;
        if (minutes > 0) {
            return String.format("%dm %ds", minutes, seconds);
        }
        return String.format("%ds", seconds);
    }

    public String getStatusClass() {
        return success ? "success" : "failure";
    }

    public String getStatusIcon() {
        return success ? "icon-blue" : "icon-red";
    }

    /**
     * Represents a single step taken by the agent.
     */
    public static class TestStep implements Serializable {
        private static final long serialVersionUID = 1L;

        private final int stepNumber;
        private final String action;
        private final String observation;
        private final String thought;

        public TestStep(int stepNumber, String action, String observation, String thought) {
            this.stepNumber = stepNumber;
            this.action = action;
            this.observation = observation;
            this.thought = thought;
        }

        public int getStepNumber() {
            return stepNumber;
        }

        public String getAction() {
            return action;
        }

        public String getObservation() {
            return observation;
        }

        public String getThought() {
            return thought;
        }
    }

    /**
     * Represents an accessibility violation found during testing.
     */
    public static class Violation implements Serializable {
        private static final long serialVersionUID = 1L;

        private final String type;
        private final String message;
        private final String element;
        private final String severity;

        public Violation(String type, String message, String element, String severity) {
            this.type = type;
            this.message = message;
            this.element = element;
            this.severity = severity;
        }

        public String getType() {
            return type;
        }

        public String getMessage() {
            return message;
        }

        public String getElement() {
            return element;
        }

        public String getSeverity() {
            return severity;
        }

        public String getSeverityClass() {
            switch (severity.toLowerCase()) {
                case "critical":
                    return "severity-critical";
                case "serious":
                    return "severity-serious";
                case "moderate":
                    return "severity-moderate";
                default:
                    return "severity-minor";
            }
        }
    }
}
