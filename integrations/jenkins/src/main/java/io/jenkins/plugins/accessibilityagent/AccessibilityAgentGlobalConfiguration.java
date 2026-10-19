package io.jenkins.plugins.accessibilityagent;

import com.cloudbees.plugins.credentials.CredentialsMatchers;
import com.cloudbees.plugins.credentials.CredentialsProvider;
import com.cloudbees.plugins.credentials.common.StandardListBoxModel;
import com.cloudbees.plugins.credentials.domains.DomainRequirement;
import hudson.Extension;
import hudson.security.ACL;
import hudson.util.FormValidation;
import hudson.util.ListBoxModel;
import jenkins.model.GlobalConfiguration;
import jenkins.model.Jenkins;
import org.jenkinsci.plugins.plaincredentials.StringCredentials;
import org.kohsuke.stapler.DataBoundSetter;
import org.kohsuke.stapler.QueryParameter;
import org.kohsuke.stapler.verb.POST;

import java.util.Collections;

@Extension
public class AccessibilityAgentGlobalConfiguration extends GlobalConfiguration {

    private String llmProvider = "openai";
    private String openaiApiKeyCredentialId;
    private String geminiApiKeyCredentialId;
    private String agentPath;
    private String nodePath = "node";
    private boolean headlessBrowser = true;
    private String dashboardUrl;
    private String dashboardApiKeyCredentialId;

    public AccessibilityAgentGlobalConfiguration() {
        load();
    }

    public static AccessibilityAgentGlobalConfiguration get() {
        return GlobalConfiguration.all().get(AccessibilityAgentGlobalConfiguration.class);
    }

    public String getLlmProvider() {
        return llmProvider;
    }

    @DataBoundSetter
    public void setLlmProvider(String llmProvider) {
        this.llmProvider = llmProvider;
        save();
    }

    public String getOpenaiApiKeyCredentialId() {
        return openaiApiKeyCredentialId;
    }

    @DataBoundSetter
    public void setOpenaiApiKeyCredentialId(String openaiApiKeyCredentialId) {
        this.openaiApiKeyCredentialId = openaiApiKeyCredentialId;
        save();
    }

    public String getGeminiApiKeyCredentialId() {
        return geminiApiKeyCredentialId;
    }

    @DataBoundSetter
    public void setGeminiApiKeyCredentialId(String geminiApiKeyCredentialId) {
        this.geminiApiKeyCredentialId = geminiApiKeyCredentialId;
        save();
    }

    public String getAgentPath() {
        return agentPath;
    }

    @DataBoundSetter
    public void setAgentPath(String agentPath) {
        this.agentPath = agentPath;
        save();
    }

    public String getNodePath() {
        return nodePath;
    }

    @DataBoundSetter
    public void setNodePath(String nodePath) {
        this.nodePath = nodePath;
        save();
    }

    public boolean isHeadlessBrowser() {
        return headlessBrowser;
    }

    @DataBoundSetter
    public void setHeadlessBrowser(boolean headlessBrowser) {
        this.headlessBrowser = headlessBrowser;
        save();
    }

    public String getDashboardUrl() {
        return dashboardUrl;
    }

    @DataBoundSetter
    public void setDashboardUrl(String dashboardUrl) {
        this.dashboardUrl = dashboardUrl;
        save();
    }

    public String getDashboardApiKeyCredentialId() {
        return dashboardApiKeyCredentialId;
    }

    @DataBoundSetter
    public void setDashboardApiKeyCredentialId(String dashboardApiKeyCredentialId) {
        this.dashboardApiKeyCredentialId = dashboardApiKeyCredentialId;
        save();
    }

    /**
     * Retrieves the dashboard API key value from credentials store
     */
    public String getDashboardApiKey() {
        if (dashboardApiKeyCredentialId == null || dashboardApiKeyCredentialId.isEmpty()) {
            return null;
        }

        StringCredentials credential = CredentialsMatchers.firstOrNull(
                CredentialsProvider.lookupCredentials(
                        StringCredentials.class,
                        Jenkins.get(),
                        ACL.SYSTEM,
                        Collections.<DomainRequirement>emptyList()
                ),
                CredentialsMatchers.withId(dashboardApiKeyCredentialId)
        );

        return credential != null ? credential.getSecret().getPlainText() : null;
    }

    /**
     * Retrieves the actual API key value from credentials store
     */
    public String getApiKey() {
        String credentialId = "openai".equals(llmProvider) ? openaiApiKeyCredentialId : geminiApiKeyCredentialId;
        if (credentialId == null || credentialId.isEmpty()) {
            return null;
        }

        StringCredentials credential = CredentialsMatchers.firstOrNull(
                CredentialsProvider.lookupCredentials(
                        StringCredentials.class,
                        Jenkins.get(),
                        ACL.SYSTEM,
                        Collections.<DomainRequirement>emptyList()
                ),
                CredentialsMatchers.withId(credentialId)
        );

        return credential != null ? credential.getSecret().getPlainText() : null;
    }

    @POST
    public FormValidation doCheckAgentPath(@QueryParameter String value) {
        Jenkins.get().checkPermission(Jenkins.ADMINISTER);
        if (value == null || value.isEmpty()) {
            return FormValidation.error("Agent path is required");
        }
        return FormValidation.ok();
    }

    @POST
    public ListBoxModel doFillOpenaiApiKeyCredentialIdItems() {
        Jenkins.get().checkPermission(Jenkins.ADMINISTER);
        return new StandardListBoxModel()
                .includeEmptyValue()
                .includeMatchingAs(
                        ACL.SYSTEM,
                        Jenkins.get(),
                        StringCredentials.class,
                        Collections.<DomainRequirement>emptyList(),
                        CredentialsMatchers.always()
                );
    }

    @POST
    public ListBoxModel doFillGeminiApiKeyCredentialIdItems() {
        Jenkins.get().checkPermission(Jenkins.ADMINISTER);
        return new StandardListBoxModel()
                .includeEmptyValue()
                .includeMatchingAs(
                        ACL.SYSTEM,
                        Jenkins.get(),
                        StringCredentials.class,
                        Collections.<DomainRequirement>emptyList(),
                        CredentialsMatchers.always()
                );
    }

    @POST
    public ListBoxModel doFillLlmProviderItems() {
        ListBoxModel items = new ListBoxModel();
        items.add("OpenAI", "openai");
        items.add("Google Gemini", "gemini");
        return items;
    }

    @POST
    public ListBoxModel doFillDashboardApiKeyCredentialIdItems() {
        Jenkins.get().checkPermission(Jenkins.ADMINISTER);
        return new StandardListBoxModel()
                .includeEmptyValue()
                .includeMatchingAs(
                        ACL.SYSTEM,
                        Jenkins.get(),
                        StringCredentials.class,
                        Collections.<DomainRequirement>emptyList(),
                        CredentialsMatchers.always()
                );
    }

    @POST
    public FormValidation doCheckDashboardUrl(@QueryParameter String value) {
        Jenkins.get().checkPermission(Jenkins.ADMINISTER);
        if (value != null && !value.isEmpty() && !value.startsWith("http")) {
            return FormValidation.error("Dashboard URL must start with http:// or https://");
        }
        return FormValidation.ok();
    }
}
