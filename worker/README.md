# Song Analyzer API Worker

Cloudflare Worker backend for the song analyzer tool.

## Features

- Accepts YouTube URLs and extracts video IDs
- Fetches video metadata from YouTube Data API (optional)
- Generates music analysis (currently mock data for demonstration)
- CORS-enabled for frontend integration
- Serverless - no server management needed

## Deployment

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

### 3. Deploy Worker

```bash
cd worker
wrangler deploy
```

This will deploy to: `https://song-analyzer-api.<your-subdomain>.workers.dev`

### 4. (Optional) Map to Custom Domain

In Cloudflare Dashboard:
1. Go to Workers & Pages
2. Click on `song-analyzer-api`
3. Go to Settings > Triggers > Custom Domains
4. Add `api.methodictruth.com`
5. Update DNS if needed (Cloudflare handles this automatically)

### 5. Update Frontend

Edit `song-analyzer.html` and change the API_URL:

```javascript
const API_URL = 'https://song-analyzer-api.<your-subdomain>.workers.dev';
// OR if using custom domain:
const API_URL = 'https://api.methodictruth.com/analyze';
```

## Configuration

### YouTube API Key (Optional)

For real video metadata (title, duration), add a YouTube Data API key:

1. Get key from [Google Cloud Console](https://console.cloud.google.com/)
2. Enable YouTube Data API v3
3. Add to worker:

```bash
wrangler secret put YOUTUBE_API_KEY
# Enter your API key when prompted
```

Without an API key, the worker uses mock video data.

## Current Implementation

⚠️ **Note:** The worker currently generates **mock analysis data** for demonstration.

For production use, you'll want to integrate:

### Real Music Analysis Options

1. **Spotify API** - If song is on Spotify
   - Get audio features (tempo, key, energy, etc.)
   - Requires Spotify developer account

2. **AcousticBrainz API** - Free music analysis
   - Get key, BPM, mood, etc.
   - Limited coverage

3. **Essentia.js** - Client-side audio analysis
   - Analyze audio directly in browser
   - Requires downloading audio

4. **Commercial APIs**
   - Chordify API (if available)
   - Hooktheory API
   - AudioKeychain

### Extending the Worker

Edit `song-analyzer-worker.js` and replace `generateMockAnalysis()` with real API calls:

```javascript
async function analyzeWithSpotify(videoTitle) {
  // Search Spotify for the song
  // Get audio features
  // Return real data
}
```

## Testing Locally

```bash
wrangler dev
```

Then test with curl:

```bash
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

## Cost

Cloudflare Workers Free Tier:
- 100,000 requests/day
- 10ms CPU time per request
- More than enough for this use case

## Support

See [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
