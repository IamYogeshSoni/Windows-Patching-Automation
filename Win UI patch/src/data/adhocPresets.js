export const APPLICATIONS_LIST = [
  'CDK Service',
  'Modern Retailing CRM',
  'Lead CRM',
  'Unify',
];

export const DMS_MACHINES = [
  { id: 'c0232', host: 'c0232.dswh.ad.com', env: 'Production US-East', status: 'ONLINE', ip: '10.142.18.232' },
  { id: 'c1184', host: 'c1184.dswh.ad.com', env: 'Production US-West', status: 'ONLINE', ip: '10.142.19.184' },
  { id: 'c0591', host: 'c0591.dslab.ad.com', env: 'Stage / QA Lab', status: 'ONLINE', ip: '10.142.24.591' },
  { id: 'c3821', host: 'c3821.dswh.ad.com', env: 'Production EU-Central', status: 'ONLINE', ip: '10.142.31.821' },
  { id: 'c9210', host: 'c9210.adp.ad.com', env: 'Disaster Recovery Lab', status: 'ONLINE', ip: '10.142.44.210' },
];

export const SCRIPT_TEMPLATES = {
  'playwright-e2e': {
    name: 'Playwright E2E UI & Synthetic Probe (Default)',
    description: 'Runs automated Playwright browser tests, parses UI validation matrix, and polls New Relic Synthetics.',
    filename: 'validation_runner.ts',
    code: `import { test, expect } from '@playwright/test';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// Step 1: Initialize Playwright Browser & Context
export async function runUiValidations(appTarget: string, hostMachine: string) {
  console.log(\`[INIT] Launching Playwright suite for \${appTarget} on host \${hostMachine}...\`);
  
  // Scenarios to evaluate
  const scenarios = [
    { name: 'Modern Retail (CRM) - Without Unify Login', endpoint: '/login/elead' },
    { name: 'Quick Quote page open', endpoint: '/quote.aspx' },
    { name: 'Oppty Review page open', endpoint: '/oppty/review' },
    { name: 'Prospect page open', endpoint: '/prospect/wizard' },
  ];

  for (const s of scenarios) {
    console.log(\`Running check: \${s.name}...\`);
  }

  // Step 2: Query New Relic Synthetics APM
  const apmEntities = [
    'BFF Unify', 'Drive Launch', 'Elead CRM API', 'Fortellis API',
    'IAM Listing Service', 'Customer Care', 'Launch AP Invoice', 'Login Workflow'
  ];

  console.log(\`Polling New Relic APM for \${apmEntities.length} entities...\`);
  return { status: 'SUCCESS', count: scenarios.length };
}

// Execute Entry Point
runUiValidations(process.env.APP_NAME || 'CDK Service', process.env.HOST_NAME || 'c0232.dswh.ad.com');
`
  },
  'api-health': {
    name: 'Microservice API & Gateway Benchmark',
    description: 'Benchmarks token authorization exchange, IAM listing, and User Preference API endpoints.',
    filename: 'api_health_probe.ts',
    code: `import axios from 'axios';

async function verifyEndpoints() {
  const endpoints = [
    '/api/v1/user/preferences',
    '/api/v1/applications/list',
    '/api/v1/workflows/active',
  ];

  for (const ep of endpoints) {
    const start = Date.now();
    console.log(\`Verifying endpoint: \${ep}...\`);
    const duration = Date.now() - start;
    console.log(\`Endpoint \${ep} returned HTTP 200 in \${duration}ms\`);
  }
}

verifyEndpoints();
`
  },
  'security-cert': {
    name: 'SSL/TLS Certificate & Cipher Validator',
    description: 'Validates TLS handshake, certificate expiry thresholds, and domain SAN bindings.',
    filename: 'ssl_tls_validator.ts',
    code: `import * as tls from 'tls';

async function checkSslCertificate(hostname: string) {
  console.log(\`Establishing TLS handshake with \${hostname}:443...\`);
  // Validate expiration threshold and cipher suite
  console.log(\`TLS Handshake successful. Certificate valid for > 45 days.\`);
}

checkSslCertificate(process.env.HOST_NAME || 'c0232.dswh.ad.com');
`
  }
};

export const RAW_PIPELINE_OUTPUT_TEMPLATE = (appName, hostMachine) => `Running step on Host ${hostMachine}...
Executing the following command(s):
$ErrorActionPreference = 'Stop'
#Install Node JS and Python dependencies
npm install playwright@latest
npm install dotenv
#python --version
#py -m pip install pywinauto python-dotenv
#run the playwright tests
npm start
added 34 packages, and audited 35 packages in 5s
1 package is looking for funding
  run \`npm fund\` for details
1 high severity vulnerability
To address all issues, run:
  npm audit fix
Run \`npm audit\` for details.
up to date, audited 35 packages in 1s
1 package is looking for funding
  run \`npm fund\` for details
1 high severity vulnerability
To address all issues, run:
  npm audit fix
Run \`npm audit\` for details.
> app-validation-poc@1.0.0 start
> npx tsc main.ts --ignoreConfig --target es2022 --module commonjs --esModuleInterop && node main.js
◇ injected env (0) from .env // tip: ⌘ multiple files { path: ['.env.local', '.env'] }
Running Playwright UI Automation Tests...
Playwright test process finished with exit code 0
Validating ${appName} UI validations....
--- lead-crm-checks Results ---
┌─────────┬─────────────────────────────────────────────┬────────┬──────────────┬───────────────────────────────────────┐
│ (index) │ check                                       │ status │ failurePoint │ reason                                │
├─────────┼─────────────────────────────────────────────┼────────┼──────────────┼───────────────────────────────────────┤
│    0    │ 'Modern Retail (CRM) - Without Unify Login' │ 'PASS' │    'NONE'    │ 'Logged in to Elead CRM'              │
│    1    │ 'Quick Quote page open'                     │ 'PASS' │    'NONE'    │ 'Quick Quote popup opened quote.aspx' │
│    2    │ 'Oppty Review page open'                    │ 'PASS' │    'NONE'    │ 'Oppty Review link opened'            │
│    3    │ 'Prospect page open'                        │ 'PASS' │    'NONE'    │ 'Add Prospect Wizard opened'          │
└─────────┴─────────────────────────────────────────────┴────────┴──────────────┴───────────────────────────────────────┘
Running New Relic Synthetic checks...
New Relic Validation Results:
CDK | Unify | BFF Unify | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfDI2NzI4OWJmLWE4Y2EtNGQ5ZS04NTE2LWVhZmVjNTMzZjg5ZA
CDK | Unify | Drive Launch | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfDM4ZGZkY2Q2LTc5OTEtNGNlYS1iYmQ1LTI1ZDBjNzQ3MGJkMg
CDK | Unify | Elead CRM API | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfDQwYzIyNDE4LWE1YzctNDI0MC1hNjhhLTM3MTM2NWE3MTFmMg
CDK | Unify | Fortellis API | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfDMzODQ2YzgyLTM4ZTYtNDAxMy1hOGRiLTAxMmUzMDcwYzRhZA
CDK | Unify | IAM Listing Service | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfGY1YWExZjZiLTBjZDAtNGM3Zi05MWY1LWMxZjc4M2IyY2U1NA
CDK | Unify | Launch Application | Customer Care | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfDBlZWIxOTkyLTA1M2ItNGFmMS05ZGRhLWU1NzVkY2Q3MzhlYw
CDK | Unify | Launch Application | Launch CDK University | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfDBkYmMxMWU5LTQ1OTItNDc5MC05NWQ2LTlhYzVmMDUwNTczOA
CDK | Unify | Launch Workflow | Launch AP Invoice | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfGZlMWFmMzgzLTkyNjctNGU2MC05MmQ0LTY3ZDM4NDJlMWQ0OA
CDK | Unify | Login Workflow | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfGFlYTVlZmUwLThlOTMtNDZlOS04MzVmLWJlMzQxNGMyNTM2NA
CDK | Unify | Navigate Workflow | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfGJhODYxMWM1LTJhZmUtNDQ3ZS05ZGEzLWM0MTE4ODhmMGJkMg
CDK | Unify | Roadster API | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfDU2Y2U1MjZlLTI0NGQtNDk2NS05NzM3LWJkOTE4MTgzZGI0ZQ
CDK | Unify | Unify Listing Service | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfGU5ZWI1ZjNjLTc3NWEtNDMzYy1hNDdlLTUxZjQ2MzlhZGQ4Mg
CDK | Unify | Unify Listing Service-app-users | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfGE4Njc3ZjU0LWIwYjgtNDVhZi04YTQ0LWEwMzRlNzhmYzVkMg
CDK | Unify | Unify Listing Service-apps | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfDcwNjdlMGRjLWM2MTYtNDQ0OC1iMGNjLWJhMTQ2ODkyY2VjNg
CDK | Unify | Unify Listing Service-workflows | 🟢 | 100 %% | https://one.newrelic.com/redirect/entity/MzM1NjQ4OHxTWU5USHxNT05JVE9SfDNmMzRhMjdiLWU5NjktNGJiZS05Y2VkLWRmODQwNGQ4OThhYg
Starting test: New Relic service checks
--- new-relic-service-checks Results ---
┌─────────┬────────────────────────────────────┬────────┬──────────────┬─────────────────────────────┐
│ (index) │ check                              │ status │ failurePoint │ reason                      │
├─────────┼────────────────────────────────────┼────────┼──────────────┼─────────────────────────────┤
│    0    │ 'New Relic Login'                  │ 'PASS' │    'NONE'    │ 'Logged in to New Relic'    │
│    1    │ 'CDK Unify Drive Launch Synthetic' │ 'PASS' │    'NONE'    │ 'Synthetic check succeeded' │
│    2    │ 'eLead CRM LoginCheck Synthetic'   │ 'PASS' │    'NONE'    │ 'Synthetic check succeeded' │
│    3    │ 'eLead CRM AutoNation Synthetic'   │ 'PASS' │    'NONE'    │ 'Synthetic check succeeded' │
│    4    │ 'eLead CRM C1User Synthetic'       │ 'PASS' │    'NONE'    │ 'Synthetic check succeeded' │
│    5    │ 'Unify Landing Page Incidents'     │ 'PASS' │    'NONE'    │ 'No active incidents'       │
│    6    │ 'eLead Landing Page Incidents'     │ 'PASS' │    'NONE'    │ 'No active incidents'       │
└─────────┴────────────────────────────────────┴────────┴──────────────┴─────────────────────────────┘
User Preference API | PASS | 200 | 301.86ms | Received HTTP 200
Get Applications API | PASS | 200 | 226.23ms | Received HTTP 200
Get Workflows API | PASS | 200 | 213.16ms | Received HTTP 200
Validating Playwright UI validations ....
Total Execution Time: 5m 42s
Parsed Results: 7 application result(s)
Compiling HTML validation report...
HTML Report generated at: C:\\HarnessDelegate\\tmp\\harness\\TohhdzHMQa2ySdLimBkodg\\reports\\report.html
Initiating Teams Webhook POST request...
Teams Webhook responded with status: 202
Payload successfully sent to Teams Webhook.
Execution Finished.
`;
