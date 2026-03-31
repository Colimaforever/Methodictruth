/**
 * Cloudflare Worker for Song Analysis
 * Handles YouTube song analysis requests
 */

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Mock data generator for demonstration
// In production, you'd integrate with real music analysis APIs
function generateMockAnalysis(videoTitle) {
  const keys = ['C Major', 'G Major', 'D Major', 'A Minor', 'E Minor', 'F Major', 'Bb Major'];
  const bpms = [90, 95, 100, 110, 120, 128, 130, 140, 145];
  
  // Common chord progressions
  const progressions = [
    ['C', 'G', 'Am', 'F'],
    ['Am', 'F', 'C', 'G'],
    ['G', 'D', 'Em', 'C'],
    ['Em', 'C', 'G', 'D'],
    ['Dm', 'G', 'C', 'Am'],
    ['F', 'G', 'C', 'Am']
  ];
  
  const progression = progressions[Math.floor(Math.random() * progressions.length)];
  
  // Generate chord timeline (repeat progression throughout song)
  const chords = [];
  const songDuration = 180 + Math.floor(Math.random() * 120); // 3-5 minutes
  const chordsPerSection = progression.length;
  const sectionsCount = 8; // Verse, Chorus, etc.
  const timePerChord = songDuration / (chordsPerSection * sectionsCount);
  
  for (let i = 0; i < sectionsCount; i++) {
    progression.forEach((chord, idx) => {
      const timestamp = Math.floor((i * chordsPerSection + idx) * timePerChord);
      chords.push({
        chord: chord,
        timestamp: timestamp
      });
    });
  }
  
  return {
    success: true,
    title: videoTitle || 'Unknown Song',
    bpm: bpms[Math.floor(Math.random() * bpms.length)],
    key: keys[Math.floor(Math.random() * keys.length)],
    duration: songDuration,
    chords: chords,
    description: `This track features a ${keys[Math.floor(Math.random() * keys.length)].toLowerCase()} tonality with a steady ${bpms[Math.floor(Math.random() * bpms.length)]} BPM tempo. The harmonic progression follows a classic pop structure, alternating between tonic and dominant chords with emotional tension built through minor chord transitions. The arrangement showcases modern production techniques with layered instrumentation and dynamic contrast between sections. Notable for its memorable melodic hooks and rhythmic drive that creates forward momentum throughout the composition.`
  };
}

async function getYouTubeVideoInfo(videoId, apiKey) {
  if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
    // Return mock data if no API key
    return {
      title: 'YouTube Video',
      duration: 180
    };
  }
  
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet,contentDetails`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.items && data.items.length > 0) {
      const video = data.items[0];
      
      // Parse ISO 8601 duration (PT3M45S -> seconds)
      const duration = video.contentDetails.duration;
      const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      const hours = parseInt(match[1] || 0);
      const minutes = parseInt(match[2] || 0);
      const seconds = parseInt(match[3] || 0);
      const totalSeconds = hours * 3600 + minutes * 60 + seconds;
      
      return {
        title: video.snippet.title,
        duration: totalSeconds
      };
    }
  } catch (error) {
    console.error('YouTube API error:', error);
  }
  
  return {
    title: 'Unknown Song',
    duration: 180
  };
}

function extractVideoId(url) {
  // Handle various YouTube URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\?\/]+)/,
    /youtube\.com\/watch\?.*v=([^&]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

async function handleRequest(request, env) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { 
      status: 405,
      headers: corsHeaders 
    });
  }
  
  try {
    const body = await request.json();
    const youtubeUrl = body.url;
    
    if (!youtubeUrl) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'YouTube URL required' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Extract video ID
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Invalid YouTube URL' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Get video info from YouTube API (optional - uses mock data if no API key)
    const apiKey = env?.YOUTUBE_API_KEY;
    const videoInfo = await getYouTubeVideoInfo(videoId, apiKey);
    
    // Generate analysis (currently mock data - replace with real analysis service)
    const analysis = generateMockAnalysis(videoInfo.title);
    analysis.duration = videoInfo.duration;
    
    return new Response(JSON.stringify(analysis), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error processing request:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to analyze song. Please try again.' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Cloudflare Worker entry point
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
