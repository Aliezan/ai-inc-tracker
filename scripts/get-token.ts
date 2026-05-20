/**
 * One-time script to get a Google OAuth2 refresh token.
 *
 * Run: npm run build && npm run google:get-token
 *
 * 1. Opens a URL in the console — paste it into your browser.
 * 2. Authorize with your Gmail account.
 * 3. Google redirects to localhost:3000/oauth/callback?code=...
 * 4. The script exchanges the code for tokens and prints them.
 * 5. Copy the refresh_token into your .env as GOOGLE_REFRESH_TOKEN.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import express from 'express';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT_URI = 'http://localhost:3000/oauth/callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Generate the authorization URL
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // Required to get a refresh_token
  prompt: 'consent',      // Force consent to always get refresh_token
  scope: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/spreadsheets', // For later Sheets usage
  ],
});

console.log('\n🔗 Open this URL in your browser to authorize:\n');
console.log(authUrl);
console.log('\nWaiting for callback...\n');

// Temporary Express server to catch the OAuth callback
const app = express();

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code as string;

  if (!code) {
    res.status(400).send('No code received');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    console.log('\n✅ Tokens received!\n');
    console.log('Access Token:', tokens.access_token);
    console.log('Refresh Token:', tokens.refresh_token);
    console.log('Expiry:', tokens.expiry_date);
    console.log('\n📋 Add this to your .env file:');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    res.send('<h1>✅ Success!</h1><p>Tokens printed in terminal. You can close this tab.</p>');

    // Shut down after receiving the token
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    console.error('Error exchanging code for tokens:', err);
    res.status(500).send('Failed to exchange code');
  }
});

app.listen(3000, () => {
  console.log('OAuth callback server listening on http://localhost:3000');
});
