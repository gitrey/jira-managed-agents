# Antigravity Agent - Forge Jira Issue Panel App

**Antigravity Agent** is an Atlassian Forge app that automatically reviews Jira story requirements using the **Google Vertex AI Interactions API**. It provides real-time progress feedback in a Jira issue panel and publishes comprehensive requirement reviews directly as native Jira issue comments.

---

## 🚀 Features

- **Automated Story Requirement Reviews:** Fetches issue details and evaluates story requirements using Google Vertex AI Agents.
- **Non-Blocking Architecture:** Uses background interaction execution and polling to stay well under Forge's 25-second function timeout limit.
- **Live Thought Stream:** Periodically polls for agent updates and renders real-time execution thoughts directly in the issue panel UI.
- **Native Rich Text Comments:** Converts Markdown reviews into Jira Wiki Markup (`h3.`, `*bold*`, `{code}`) to post formatted comments to Jira issues.
- **Forge UI Kit Rendering:** Built with `@forge/react` UI Kit components (`Heading`, `List`, `CodeBlock`, `Stack`) for a clean native Atlassian experience.

---

## 🛠️ Architecture

![Antigravity Agent Flow](./flow.png)

For a detailed sequence diagram and breakdown of component interactions (Jira UI Panel $\rightarrow$ Forge Backend Resolvers $\rightarrow$ Vertex AI Interactions API $\rightarrow$ Jira REST API), see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 🔒 Security & Server-Side Authentication

All GCP authentication operations run 100% server-side inside Atlassian Forge's secure backend FaaS environment ([src/resolvers/index.js](./src/resolvers/index.js)):

- **Zero Secret Exposure:** Credentials (`GCP_SERVICE_ACCOUNT_KEY`, `ACCESS_TOKEN`) are stored in encrypted Forge secret storage. Private RSA keys and OAuth access tokens are never transmitted to or accessible by the client browser.
- **Server-Side JWT Signing:** When configured with `GCP_SERVICE_ACCOUNT_KEY`, the backend resolver uses Node.js `crypto` to generate and sign an RSA-256 JWT assertion, exchanging it with `https://oauth2.googleapis.com/token` for dynamic access tokens.
- **Strict Egress Controls:** External network access is strictly declared in `manifest.yml` and restricted to `aiplatform.googleapis.com` and `oauth2.googleapis.com`.

---

## ⚡ Smart Caching & Review Execution Flow

The issue panel uses Jira Issue Property state (`antigravity_review`) to handle review caching and automatic re-evaluations:

- **Page Reload / Closing & Reopening Panel (Requirements Unchanged):** The app checks the saved Jira Issue Property. If the cached `description` matches the current issue description, it loads instantly from storage **without invoking the agent**.
- **Editing Story Requirements / Description:** When the story description is updated in Jira, the app detects the requirement change (`cachedDescription !== currentDescription`), automatically calls the Vertex AI agent to re-evaluate the updated story, posts a new Jira comment, and updates the saved panel state.
- **Manual Re-Run:** Clicking the **"Re-run Agent Review"** button in the panel bypasses the cache and forces a fresh agent evaluation at any time.

---

## 📋 Prerequisites & Configuration

Create new Forge application. [Create a Forge app](https://developer.atlassian.com/platform/forge/getting-started/#build-your-first-forge-app)

### Environment Variables

Create Forge API token here [Create an API token](https://id.atlassian.com/manage/api-tokens)

```bash
export FORGE_EMAIL=YOUR_EMAIL
export FORGE_API_TOKEN=YOUR_API_TOKEN
```

Check that you are logged in with:

```bash
forge whoami
```

```bash
export PROJECT_ID="your-project-id"
export AGENT_ID="your-agent-id" # "projects/123456789/locations/global/agents/agent-name"
export ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
```

The backend resolver supports two authentication methods for Google Vertex AI:

#### 1. GCP Service Account Key (If Key Creation is Allowed)
*Note: If your GCP organization enforces `constraints/iam.disableServiceAccountKeyCreation`, skip to Option 2 below.*

```bash
# Set your GCP Project ID
export PROJECT_ID="your-gcp-project-id"

# 1. Create a Service Account
gcloud iam service-accounts create jira-antigravity-agent \
  --description="Service Account for JIRA Antigravity Agent" \
  --display-name="JIRA Antigravity Agent SA"

# 2. Grant Agent Platform User role to the Service Account
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:jira-antigravity-agent@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user" \
  --condition=None

# Disable key creation restriction on your project
# gcloud resource-manager org-policies disable-enforce iam.disableServiceAccountKeyCreation --project=$PROJECT_ID

# 3. Create and download the Service Account Key JSON file
gcloud iam service-accounts keys create service-account-key.json \
  --iam-account="jira-antigravity-agent@$PROJECT_ID.iam.gserviceaccount.com"

# 4. Set encrypted Forge environment variables
forge variables set --encrypt GCP_SERVICE_ACCOUNT_KEY "$(cat service-account-key.json)"
forge variables set AGENT_ID <your-vertex-agent-id>
forge variables set PROJECT_ID $PROJECT_ID
```

#### 2. Access Token Authentication (When Key Creation is Disabled by Org Policy)
When Service Account key creation is restricted by GCP Organization Policy, generate a short-lived OAuth 2.0 access token (or Service Account impersonation access token) and set it in Forge:

```bash
export PROJECT_ID="devproductivity-3145-8712"
export AGENT_ID="your-vertex-agent-id"

# Generate access token (User OAuth token or Service Account Impersonation token)
forge variables set --encrypt ACCESS_TOKEN "$(gcloud auth print-access-token)"
forge variables set AGENT_ID "$AGENT_ID"
forge variables set PROJECT_ID "$PROJECT_ID"
```

### Manifest Permissions & Egress

The app requires:
- **Jira Scopes:** `read:jira-work`, `write:jira-work`
- **External Egress:** `aiplatform.googleapis.com`, `oauth2.googleapis.com` (configured under `permissions.external.fetch.backend` in `manifest.yml`)

---

## 🚦 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Lint & Validate Manifest
```bash
forge lint
```

### 3. Deploy the App
Deploy the app to your development environment:
```bash
forge deploy
```

### 4. Install on Jira Site
Install the app to your Atlassian site:
```bash
forge install
```

### 5. Local Tunneling (Development)
Run local tunneling to hot-reload frontend and resolver changes:
```bash
forge tunnel
```

---

## 📁 Project Structure

```
Antigravity-Agent/
├── ARCHITECTURE.md       # Sequence diagram and design notes
├── README.md             # Project documentation
├── manifest.yml          # Forge app manifest & permissions
├── package.json          # Node dependencies & metadata
└── src/
    ├── frontend/
    │   └── index.jsx     # Forge UI Kit issue panel component
    └── resolvers/
        └── index.js      # Forge backend resolvers for Interactions API
```
