# Deployment Instructions

## Environment Variables (Cloudflare Pages)

The Song Analyzer requires these environment variables to be set in Cloudflare Pages:

1. Go to Cloudflare Dashboard → Pages → methodictruth → Settings → Environment variables

2. Add these variables for **Production**:

   - `YOUTUBE_API_KEY` = `AIzaSyAimEQ7sMiohbUwAto8UvTQZfFQFXne4ts`
   - `ANTHROPIC_API_KEY` = Your Claude API key

3. Save and redeploy

## API Key Security

- YouTube API key is restricted to YouTube Data API v3 only
- Optionally add HTTP referrer restriction: `methodictruth.com/*`
- Monitor usage at https://console.cloud.google.com/apis/dashboard

## Local Development

1. Copy `.env.example` to `.env`
2. Fill in your API keys
3. Run `node server.js`
4. Access at http://localhost:8080/analyze.html
