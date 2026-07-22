import Resolver from '@forge/resolver';
import api from '@forge/api';
import crypto from 'crypto';

const resolver = new Resolver();

/**
 * Base64Url encoder according to RFC 7515 specifications.
 * Converts string or Buffer data to URL-safe base64 without padding.
 * 
 * @param {string|Buffer} input - Text string or binary buffer to encode
 * @returns {string} Base64Url encoded string
 */
function base64UrlEncode(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Fetches an OAuth 2.0 access token for authenticating with GCP APIs.
 * 
 * Logic flow:
 * 1. Checks if GCP_SERVICE_ACCOUNT_KEY environment variable is defined.
 * 2. If defined, parses the service account JSON, builds a signed RSA-256 JWT claim set,
 *    and exchanges it with `https://oauth2.googleapis.com/token`.
 * 3. Fallback: If GCP_SERVICE_ACCOUNT_KEY is not defined, uses ACCESS_TOKEN environment variable.
 * 
 * @returns {Promise<string>} Valid OAuth 2.0 access token
 */
async function getAccessToken() {
  const serviceAccountKeyRaw = process.env.GCP_SERVICE_ACCOUNT_KEY;

  if (serviceAccountKeyRaw) {
    try {
      const sa = typeof serviceAccountKeyRaw === 'string'
        ? JSON.parse(serviceAccountKeyRaw)
        : serviceAccountKeyRaw;

      const clientEmail = sa.client_email;
      const privateKey = sa.private_key;

      if (!clientEmail || !privateKey) {
        throw new Error('GCP_SERVICE_ACCOUNT_KEY missing client_email or private_key.');
      }

      // Build standard OAuth 2.0 JWT claim set for Google Cloud APIs
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: 'RS256', typ: 'JWT' };
      const claimSet = {
        iss: clientEmail,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
      };

      const encodedHeader = base64UrlEncode(JSON.stringify(header));
      const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
      const unsignedJwt = `${encodedHeader}.${encodedClaimSet}`;

      // Sign JWT assertion using standard Node.js crypto module
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(unsignedJwt);
      const signature = signer.sign(privateKey);
      const encodedSignature = base64UrlEncode(signature);

      const signedJwt = `${unsignedJwt}.${encodedSignature}`;

      // Request fresh access token from Google OAuth endpoint
      const tokenRes = await api.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: signedJwt
        }).toString()
      });

      if (!tokenRes.ok) {
        const tokenErrText = await tokenRes.text();
        throw new Error(`Google OAuth token exchange failed (Status ${tokenRes.status}): ${tokenErrText}`);
      }

      const tokenData = await tokenRes.json();
      return tokenData.access_token;
    } catch (err) {
      console.error('Error deriving OAuth access token from GCP_SERVICE_ACCOUNT_KEY:', err);
      throw err;
    }
  }

  // Fallback to static ACCESS_TOKEN if configured
  const staticToken = process.env.ACCESS_TOKEN;
  if (staticToken) {
    return staticToken;
  }

  throw new Error('No GCP authentication configured. Please set GCP_SERVICE_ACCOUNT_KEY or ACCESS_TOKEN environment variable.');
}

// 1. Start interaction (returns immediately with interactionId)
resolver.define('startReviewStory', async (req) => {
  try {
    const { description } = req.payload;

    const projectId = process.env.PROJECT_ID;
    const agentId = process.env.AGENT_ID;
    const accessToken = await getAccessToken();

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
    const accessToken = await getAccessToken();

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
