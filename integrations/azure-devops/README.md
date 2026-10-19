# AT Agent Azure DevOps Extension

Azure Pipelines extension for running AI-powered accessibility tests using a virtual screen reader.

## Building the Extension

### Prerequisites

- Node.js 20+
- npm

### Build Steps

1. Install dependencies for the extension:
   ```bash
   cd azure-devops-extension
   npm install
   ```

2. Install dependencies for the task:
   ```bash
   cd tasks/accessibility-agent
   npm install
   ```

3. Build the task:
   ```bash
   npm run build
   ```

4. Package the extension:
   ```bash
   cd ../..
   npm run package
   ```

This will create a `.vsix` file in the `dist` directory.

## Sideloading for Testing

1. Go to your Azure DevOps organization
2. Navigate to Organization Settings > Extensions
3. Click "Upload extension" (or go to Manage extensions > Browse local extensions)
4. Upload the `.vsix` file from the `dist` directory

## Usage in Azure Pipelines

```yaml
trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'
    displayName: 'Install Node.js'

  - script: |
      git clone https://github.com/your-org/at-agent.git $(Agent.BuildDirectory)/at-agent
      cd $(Agent.BuildDirectory)/at-agent
      npm install
      npx playwright install --with-deps chromium
    displayName: 'Install AT Agent'

  - task: accessibility-agent@1
    inputs:
      testConfig: 'accessibility-tests.json'
      provider: 'openai'
      openaiApiKey: $(OPENAI_API_KEY)
      agentPath: '$(Agent.BuildDirectory)/at-agent'
      headless: true
      continueOnFailure: true
      dashboardUrl: 'https://your-dashboard.example.com'
      dashboardApiKey: $(DASHBOARD_API_KEY)
    displayName: 'Run Accessibility Tests'

  - script: |
      echo "Total Tests: $(totalTests)"
      echo "Passed: $(passedTests)"
      echo "Failed: $(failedTests)"
      echo "Pass Rate: $(passRate)%"
    displayName: 'Display Results'
    condition: always()
```

## Test Configuration File

Create a JSON file with your test cases:

```json
[
  {
    "url": "https://example.com",
    "goal": "Navigate to the main content and verify all headings are properly structured"
  },
  {
    "url": "https://example.com/login",
    "goal": "Fill out the login form and submit it using only keyboard navigation"
  }
]
```

Or use a simple text format:

```
https://example.com|Navigate to the main content and verify headings
https://example.com/login|Fill out and submit the login form
```

## Publishing to Marketplace

1. Create a publisher at https://marketplace.visualstudio.com/manage/publishers
2. Update `publisher` in `vss-extension.json` with your publisher ID
3. Generate a Personal Access Token (PAT) with Marketplace scope
4. Run:
   ```bash
   npx tfx extension publish --token <your-pat>
   ```

## Development

### Project Structure

```
azure-devops-extension/
├── vss-extension.json      # Extension manifest
├── package.json            # Extension package
├── overview.md             # Marketplace description
├── README.md               # This file
├── images/
│   └── icon.png           # Extension icon
└── tasks/
    └── accessibility-agent/
        ├── task.json      # Task definition
        ├── package.json   # Task dependencies
        ├── tsconfig.json  # TypeScript config
        └── src/
            └── index.ts   # Task implementation
```

### Making Changes

1. Modify the task source in `tasks/accessibility-agent/src/index.ts`
2. Rebuild: `cd tasks/accessibility-agent && npm run build`
3. Repackage: `cd ../.. && npm run package`
4. Re-upload the `.vsix` file to test

## License

MIT
