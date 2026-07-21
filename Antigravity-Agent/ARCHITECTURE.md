# Antigravity Agent Architecture

This document describes the sequence of calls between the **Jira UI**, **Forge Backend Resolvers**, **Google Vertex AI Interactions API**, and the **Jira REST API**.

## Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Jira User
    participant UI as Forge UI Panel (index.jsx)
    participant Resolver as Forge Backend Resolver (index.js)
    participant Vertex as Vertex AI Interactions API
    participant JiraAPI as Jira REST API

    User->>UI: Opens Jira Issue Panel
    activate UI
    UI->>JiraAPI: requestJira GET /rest/api/2/issue/{issueId}
    JiraAPI-->>UI: Returns Issue Details & Description
    
    UI->>Resolver: invoke("startReviewStory", { description })
    activate Resolver
    Note over Resolver: Reads process.env (PROJECT_ID, AGENT_ID, ACCESS_TOKEN)
    Resolver->>Vertex: POST /interactions (background: true)
    Vertex-->>Resolver: Returns { interactionId, status: "in_progress" }
    Resolver-->>UI: Returns { interactionId, status: "in_progress" }
    deactivate Resolver

    loop Poll every 4 seconds (non-blocking)
        UI->>Resolver: invoke("checkReviewStatus", { interactionId })
        activate Resolver
        Resolver->>Vertex: GET /interactions/{interactionId}
        Vertex-->>Resolver: Returns status & step content
        alt Status: "in_progress"
            Resolver-->>UI: Returns { status: "in_progress", latestMessage }
            UI->>User: Displays live thought message ("Searching docs...", "Evaluating INVEST...")
        else Status: "completed"
            Resolver-->>UI: Returns { status: "completed", text: reviewText }
        end
        deactivate Resolver
    end

    UI->>UI: markdownToJiraWiki(reviewText)
    UI->>JiraAPI: requestJira POST /rest/api/2/issue/{issueId}/comment
    JiraAPI-->>UI: Comment Saved
    UI->>User: Renders UI Panel with native @forge/react components & displays Jira comment
    deactivate UI
```

## Architectural Design Highlights

1. **Non-Blocking Invocations:**  
   The initial `startReviewStory` call returns in `< 1s` with an `interactionId`. Polling calls `checkReviewStatus` also return in `< 1s`. Neither call ever hits Atlassian Forge's hard 25-second function execution limit.

2. **Live Agent Progress Feed:**  
   While `status === 'in_progress'`, the frontend polls every 4 seconds and displays real-time agent thoughts in the UI panel.

3. **Rich Text & Wiki Markup Rendering:**  
   - **UI Panel:** Renders native `@forge/react` UI Kit components (`Heading`, `List`, `CodeBlock`).
   - **Jira Comments:** Converts Markdown to Jira Wiki Markup (`h3.`, `*bold*`, `{code}`) for native rich text rendering in issue comments.
