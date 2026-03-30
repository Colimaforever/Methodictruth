/**
 * Cloudflare Pages Function: YouTube Song Analyzer
 * Serverless endpoint for music analysis
 */

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const videoId = url.searchParams.get('videoId');

    if (!videoId) {
        return new Response(JSON.stringify({ error: 'videoId parameter required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        // Get video metadata from YouTube
        const videoInfo = await getVideoInfo(videoId, env.YOUTUBE_API_KEY);
        
        // Generate AI analysis using Claude
        const analysis = await generateAnalysis(videoInfo, env.ANTHROPIC_API_KEY);
        
        // Get music features (basic estimation for now)
        const musicData = estimateMusicFeatures(videoInfo);

        return new Response(JSON.stringify({
            title: videoInfo.title,
            channel: videoInfo.channel,
            musicData,
            analysis
        }), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
            }
        });
    } catch (error) {
        console.error('Analysis error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

async function getVideoInfo(videoId, apiKey) {
    if (!apiKey) {
        throw new Error('YouTube API key not configured');
    }
    const url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet,contentDetails`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data.items || data.items.length === 0) {
        throw new Error('Video not found');
    }
    
    const video = data.items[0];
    return {
        title: video.snippet.title,
        channel: video.snippet.channelTitle,
        description: video.snippet.description,
        duration: video.contentDetails.duration
    };
}

async function generateAnalysis(videoInfo, apiKey) {
    const prompt = `Analyze this song based on its title and context:

Title: "${videoInfo.title}"
Artist/Channel: ${videoInfo.channel}

Provide a concise musical analysis (2-3 paragraphs) covering:
- Genre and style
- Likely instrumentation and arrangement
- Harmonic/melodic characteristics
- Rhythmic elements and tempo feel
- Emotional character and mood
- Any distinctive musical features

Be insightful but accessible. Focus on what makes this music interesting.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4',
            max_tokens: 1024,
            messages: [{
                role: 'user',
                content: prompt
            }]
        })
    });

    const data = await response.json();
    
    if (!response.ok) {
        throw new Error('AI analysis failed');
    }
    
    return data.content[0].text;
}

function estimateMusicFeatures(videoInfo) {
    // This is a basic estimation based on title/description
    // In a production system, you'd use actual audio analysis APIs
    // like Spotify API, AcousticBrainz, or custom ML models
    
    const title = videoInfo.title.toLowerCase();
    const desc = (videoInfo.description || '').toLowerCase();
    const text = title + ' ' + desc;
    
    // Simple keyword-based estimation
    let estimatedKey = 'Unknown';
    let estimatedTempo = null;
    let estimatedMode = 'Unknown';
    let chords = [];
    
    // Genre-based tempo estimation
    if (text.match(/metal|punk|hardcore/)) {
        estimatedTempo = '140-180';
    } else if (text.match(/ballad|slow|ambient/)) {
        estimatedTempo = '60-80';
    } else if (text.match(/dance|edm|house|techno/)) {
        estimatedTempo = '120-130';
    } else if (text.match(/hip hop|rap|trap/)) {
        estimatedTempo = '70-90';
    }
    
    // Extract key if mentioned in title/description
    const keyMatch = text.match(/\b([A-G][#b]?)\s*(major|minor|maj|min)/i);
    if (keyMatch) {
        estimatedKey = keyMatch[1] + ' ' + (keyMatch[2].startsWith('maj') ? 'Major' : 'Minor');
        estimatedMode = keyMatch[2].startsWith('maj') ? 'Major' : 'Minor';
    }
    
    return {
        key: estimatedKey,
        tempo: estimatedTempo,
        timeSignature: '4/4', // Default assumption
        mode: estimatedMode,
        chords: chords,
        note: 'Music features are estimated. For accurate analysis, audio processing would be required.'
    };
}
