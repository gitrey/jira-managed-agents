import Resolver from '@forge/resolver';
import api from '@forge/api';

const resolver = new Resolver();

// 1. Start interaction (returns immediately with interactionId)
resolver.define('startReviewStory', async (req) => {
  try {
    const { description } = req.payload;

    const projectId = process.env.PROJECT_ID;
    const agentId = process.env.AGENT_ID;
    const accessToken = process.env.ACCESS_TOKEN;

    const agentUrl = `https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/global/interactions`;

    const bodyGenerateData = JSON.stringify({
      agent: agentId,
      background: true,
      input: {
        type: 'text',
        text: `Review this story requirements: ${description}`
      }
    });

    const createRes = await api.fetch(agentUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: bodyGenerateData
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return { error: `Failed to start agent (Status ${createRes.status}): ${errText}` };
    }

    const interaction = await createRes.json();
    return { interactionId: interaction.id, status: interaction.status };
  } catch (err) {
    console.error('Error starting reviewStory:', err);
    return { error: `Backend error: ${err.message || err}` };
  }
});

// 2. Check interaction status (returns status, clean final text if completed, or latestMessage if in_progress)
resolver.define('checkReviewStatus', async (req) => {
  try {
    const { interactionId } = req.payload;

    const projectId = process.env.PROJECT_ID;
    const accessToken = process.env.ACCESS_TOKEN;

    const getUrl = `https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/global/interactions/${interactionId}`;

    const getRes = await api.fetch(getUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!getRes.ok) {
      const errText = await getRes.text();
      return { error: `Failed to check status (Status ${getRes.status}): ${errText}` };
    }

    const getJson = await getRes.json();
    const status = getJson.status;
    const steps = getJson.steps || [];

    if (status === 'completed') {
      const modelTexts = [];
      for (const step of steps) {
        if (step.type === 'model_output') {
          for (const c of step.content || []) {
            if (c.text) {
              modelTexts.push(c.text);
            }
          }
        }
      }

      // 1. Join stream chunks directly with empty string '' to prevent broken mid-sentence newlines
      let fullOutput = modelTexts.join('');

      // 2. Strip out preliminary progress/thinking logs if final review heading exists
      const reviewStartIndex = fullOutput.search(/(###|Here is|1\.\s+High-Level|1\.\s+Functional|\*\*Current Story)/i);
      if (reviewStartIndex > 0) {
        fullOutput = fullOutput.substring(reviewStartIndex).trim();
      }

      return { status: 'completed', text: fullOutput || 'Review completed.' };
    }

    // Extract the most recent agent thought / progress message for live feedback
    let latestMessage = '';
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step.type === 'model_output') {
        for (const c of step.content || []) {
          if (c.text) {
            latestMessage = c.text;
            break;
          }
        }
        if (latestMessage) break;
      }
    }

    return {
      status: status || 'in_progress',
      stepCount: steps.length,
      latestMessage: latestMessage || 'Analyzing requirements...'
    };
  } catch (err) {
    console.error('Error checking reviewStory status:', err);
    return { error: `Backend error: ${err.message || err}` };
  }
});

export const handler = resolver.getDefinitions();
