import React from 'react';
import ForgeReconciler, { Text, Heading, CodeBlock, List, ListItem, Stack, Button, Inline, useProductContext } from '@forge/react';
import { requestJira, invoke } from '@forge/bridge';

const PROPERTY_KEY = 'antigravity_review';

// Convert standard Markdown to Jira Wiki Markup for native rich comment rendering
const markdownToJiraWiki = (md) => {
  if (!md) return '';
  let wiki = md;
  wiki = wiki.replace(/```(\w+)?\n([\s\S]*?)```/g, (m, lang, code) => `{code${lang ? ':' + lang : ''}}\n${code.trim()}\n{code}`);
  wiki = wiki.replace(/^#### (.*$)/gim, 'h4. $1');
  wiki = wiki.replace(/^### (.*$)/gim, 'h3. $1');
  wiki = wiki.replace(/^## (.*$)/gim, 'h2. $1');
  wiki = wiki.replace(/^# (.*$)/gim, 'h1. $1');
  wiki = wiki.replace(/\*\*(.*?)\*\*/g, '*$1*');
  wiki = wiki.replace(/`([^`]+)`/g, '{{$1}}');
  return wiki;
};

// Render UI Kit components for frontend panel layout without raw markdown clutter
const renderMarkdown = (text) => {
  if (!text) return null;

  const lines = text.split('\n');
  const elements = [];
  let inCodeBlock = false;
  let codeBuffer = [];
  let currentList = [];

  const flushList = () => {
    if (currentList.length > 0) {
      elements.push(
        <List key={`list-${elements.length}`}>
          {currentList.map((item, idx) => (
            <ListItem key={idx}>
              <Text>{item}</Text>
            </ListItem>
          ))}
        </List>
      );
      currentList = [];
    }
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <CodeBlock key={`code-${index}`} text={codeBuffer.join('\n')} />
        );
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        flushList();
        inCodeBlock = true;
      }
      return;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      return;
    }

    // Clean inline formatting symbols (e.g. **) for UI Kit text rendering
    const cleanText = trimmed.replace(/\*\*/g, '');

    if (trimmed.startsWith('#### ')) {
      flushList();
      elements.push(<Heading key={index} as="h4">{cleanText.replace('#### ', '')}</Heading>);
      return;
    }
    if (trimmed.startsWith('### ')) {
      flushList();
      elements.push(<Heading key={index} as="h3">{cleanText.replace('### ', '')}</Heading>);
      return;
    }
    if (trimmed.startsWith('## ')) {
      flushList();
      elements.push(<Heading key={index} as="h2">{cleanText.replace('## ', '')}</Heading>);
      return;
    }
    if (trimmed.startsWith('# ')) {
      flushList();
      elements.push(<Heading key={index} as="h1">{cleanText.replace('# ', '')}</Heading>);
      return;
    }

    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      currentList.push(cleanText.replace(/^[*|-]\s+/, ''));
      return;
    } else {
      flushList();
    }

    if (!cleanText || cleanText === '---') {
      return;
    }

    elements.push(<Text key={index}>{cleanText}</Text>);
  });

  flushList();
  return <Stack space="space.100">{elements}</Stack>;
};

const App = () => {
  const context = useProductContext();
  const [description, setDescription] = React.useState('Initializing agent review...');
  const [isLoading, setIsLoading] = React.useState(false);
  const [hasCompleted, setHasCompleted] = React.useState(false);

  const issueId = 
    context?.extension?.issue?.id || 
    context?.extension?.issue?.key ||
    context?.extension?.issueId ||
    context?.extension?.issueKey;

  const runAgentReview = async (forced = false) => {
    if (!issueId) {
      setDescription('No issue context available.');
      return;
    }

    setIsLoading(true);

    try {
      // 1. Fetch current issue details from Jira
      setDescription('Fetching issue details...');
      const res = await requestJira(`/rest/api/2/issue/${issueId}`);
      if (!res.ok) {
        setDescription(`Failed to fetch issue details (Status: ${res.status})`);
        setIsLoading(false);
        return;
      }
      const data = await res.json();

      const rawDescription = data.fields?.description;
      const issueDescription = typeof rawDescription === 'string'
        ? rawDescription
        : (rawDescription ? JSON.stringify(rawDescription) : 'No description provided');

      // 2. Check if a cached review exists AND the story description has NOT changed
      if (!forced) {
        try {
          const propRes = await requestJira(`/rest/api/2/issue/${issueId}/properties/${PROPERTY_KEY}`);
          if (propRes.ok) {
            const propJson = await propRes.json();
            // Only use cached review if description matches current issue description
            if (propJson.value?.review && propJson.value?.description === issueDescription) {
              setDescription(propJson.value.review);
              setHasCompleted(true);
              setIsLoading(false);
              return;
            }
          }
        } catch (e) {
          console.log('Property check failed:', e);
        }
      }

      // 3. Story description changed or forced re-run -> Invoke agent for review
      setDescription('Starting agent review for updated requirements...');
      const startRes = await invoke('startReviewStory', {
        description: issueDescription
      });

      if (startRes.error) {
        setDescription(startRes.error);
        setIsLoading(false);
        return;
      }

      const interactionId = startRes.interactionId;
      setDescription('Agent is reviewing story requirements... Please wait.');

      // 4. Poll status from frontend (every 4 seconds) and show descriptive progress
      const maxAttempts = 30; // Up to 2 minutes
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 4000));

        const statusRes = await invoke('checkReviewStatus', { interactionId });
        if (statusRes.error) {
          setDescription(statusRes.error);
          setIsLoading(false);
          return;
        }

        if (statusRes.status === 'completed') {
          const reviewText = statusRes.text;

          // Save review AND current description to Jira Issue Property
          await requestJira(`/rest/api/2/issue/${issueId}/properties/${PROPERTY_KEY}`, {
            method: 'PUT',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              review: reviewText,
              description: issueDescription,
              updatedAt: new Date().toISOString()
            })
          });

          // Convert Markdown to Jira Wiki Markup for Jira comment REST API
          const wikiMarkupBody = markdownToJiraWiki(reviewText);

          // Add review comment to Jira issue using native Jira Wiki Markup
          await requestJira(`/rest/api/2/issue/${issueId}/comment`, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ body: wikiMarkupBody })
          });

          setDescription(reviewText);
          setHasCompleted(true);
          setIsLoading(false);
          return;
        }

        const currentMessage = statusRes.latestMessage || `Agent review in progress (step ${attempt + 1})...`;
        setDescription(currentMessage);
      }

      setDescription('Agent review took longer than expected. Check Jira issue comments in a few moments.');
    } catch (err) {
      console.error('Error processing story review:', err);
      setDescription(`Error: ${err.message || err}`);
    } finally {
      setIsLoading(false);
    }
  };

  React.useEffect(() => {
    if (context && issueId) {
      runAgentReview(false);
    }
  }, [context, issueId]);

  return (
    <Stack space="space.200">
      {renderMarkdown(description)}
      {hasCompleted && !isLoading && (
        <Inline alignInline="end">
          <Button appearance="subtle" onClick={() => runAgentReview(true)}>
            Re-run Agent Review
          </Button>
        </Inline>
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);