// Supabase Client Initialization

let supabase = null;

// Initialize Supabase client
function initSupabase() {
    if (typeof supabase === 'undefined' || !supabase) {
        try {
            supabase = window.supabase.createClient(
                SUPABASE_CONFIG.url,
                SUPABASE_CONFIG.anonKey
            );
            console.log('✅ Supabase client initialized');
            return true;
        } catch (error) {
            console.error('❌ Failed to initialize Supabase:', error);
            showMessage('Failed to connect to Supabase. Please check your configuration.', 'error');
            return false;
        }
    }
    return true;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    if (SUPABASE_CONFIG.url !== 'YOUR_SUPABASE_URL' && SUPABASE_CONFIG.anonKey !== 'YOUR_SUPABASE_ANON_KEY') {
        initSupabase();
    }
});

