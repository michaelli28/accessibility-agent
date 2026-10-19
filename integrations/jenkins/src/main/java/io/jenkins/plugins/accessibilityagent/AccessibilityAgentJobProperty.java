package io.jenkins.plugins.accessibilityagent;

import hudson.Extension;
import hudson.model.Action;
import hudson.model.Job;
import hudson.model.JobProperty;
import hudson.model.JobPropertyDescriptor;
import jenkins.model.TransientActionFactory;

import java.util.Collection;
import java.util.Collections;

/**
 * Factory that adds the AccessibilityAgentProjectAction to jobs that have had accessibility tests run.
 */
@Extension
public class AccessibilityAgentJobProperty extends TransientActionFactory<Job> {

    @Override
    public Class<Job> type() {
        return Job.class;
    }

    @Override
    public Collection<? extends Action> createFor(Job target) {
        // Check if this job has ever had accessibility test results
        if (hasAccessibilityResults(target)) {
            return Collections.singleton(new AccessibilityAgentProjectAction(target));
        }
        return Collections.emptyList();
    }

    private boolean hasAccessibilityResults(Job<?, ?> job) {
        // Check recent builds for accessibility results
        var run = job.getLastBuild();
        int checksRemaining = 10; // Only check last 10 builds for performance

        while (run != null && checksRemaining > 0) {
            if (run.getAction(AccessibilityAgentBuildAction.class) != null) {
                return true;
            }
            run = run.getPreviousBuild();
            checksRemaining--;
        }
        return false;
    }
}
