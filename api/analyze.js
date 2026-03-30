/**
 * YouTube Song Analyzer API
 * Handles music analysis requests
 */

const https = require('https');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// YouTube Data API key (you'll need to provide this)
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'YOUR_API_KEY_HERE';

async function getVideoInfo(videoId) {
    return new Promise((resolve, reject) => {
        const url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${YOUTUBE_API_KEY}&part=snippet,contentDetails`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        const video = json.items[0];
                        resolve({
                            title: video.snippet.title,
                            channel: video.snippet.channelTitle,
                            duration: video.contentDetails.duration
                        });
                    } else {
                        reject(new Error('Video not found'));
                    }
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

async function analyzeMusicWithAI(videoInfo) {
    // Use OpenClaw to generate AI analysis
    const prompt = `Analyze this song and provide insights:

Title: ${videoInfo.title}
Channel: ${videoInfo.channel}

Provide a detailed musical analysis covering:
1. Genre and style
2. Arrangement characteristics (instrumentation, production style)
3. Harmonic structure and progression patterns
4. Rhythmic elements
5. Emotional character and mood
6. Notable musical techniques or features

Keep it informative but accessible. 2-3 paragraphs.`;

    try {
        // Call OpenClaw agent to generate analysis
        const { stdout } = await execAsync(`openclaw agent send --message "${prompt.replace(/"/g, '\\"')}" --session main`);
        return stdout.trim();
    } catch (error) {
        return "AI analysis temporarily unavailable. Please try again later.";
    }
}

async function detectMusicFeatures(videoId, videoInfo) {
    // This is a placeholder - in production you'd use:
    // - Spotify API (if the song is on Spotify)
    // - AcousticBrainz API
    // - Custom audio analysis with librosa/Essentia
    // - ML models for chord detection
    
    // For now, return mock data structure
    // You'll replace this with actual API calls
    
    return {
        key: "Unknown",
        tempo: null,
        timeSignature: "4/4",
        mode: "Unknown",
        chords: [] // Empty for now - will be populated by actual analysis
    };
}

async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const videoId = url.searchParams.get('videoId');

    if (!videoId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'videoId parameter required' }));
        return;
    }

    try {
        // Get video metadata
        const videoInfo = await getVideoInfo(videoId);
        
        // Detect music features
        const musicData = await detectMusicFeatures(videoId, videoInfo);
        
        // Generate AI analysis
        const analysis = await analyzeMusicWithAI(videoInfo);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            title: videoInfo.title,
            channel: videoInfo.channel,
            musicData,
            analysis
        }));
    } catch (error) {
        console.error('Analysis error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

module.exports = handler;
