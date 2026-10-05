// Supabase Configuration
// Replace these with your actual Supabase credentials

const SUPABASE_CONFIG = {
    // Get these from your Supabase project settings
    // Go to: Settings → API
    url: 'YOUR_SUPABASE_URL',  // e.g., 'https://xxxxx.supabase.co'
    anonKey: 'YOUR_SUPABASE_ANON_KEY'  // e.g., 'eyJhbGc...' (long string)
};

// Check if config is set
if (SUPABASE_CONFIG.url === 'YOUR_SUPABASE_URL' || SUPABASE_CONFIG.anonKey === 'YOUR_SUPABASE_ANON_KEY') {
    console.warn('⚠️ Supabase credentials not configured!');
    console.warn('Please update js/config.js with your Supabase URL and API key');
    
    // Show notice to user
    document.addEventListener('DOMContentLoaded', () => {
        const notice = document.getElementById('configNotice');
        if (notice) {
            notice.style.display = 'block';
        }
    });
}

