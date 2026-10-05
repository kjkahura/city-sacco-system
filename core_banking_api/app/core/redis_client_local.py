"""
Redis client configuration for local development (optional)
"""

redis_client = None
use_redis = False

try:
    import redis
    from app.core.config_local import settings

    # Try to create Redis client (optional for local development)
    try:
        test_client = redis.from_url(settings.REDIS_URL, decode_responses=True, socket_connect_timeout=0.5, socket_timeout=0.5)
        # Test connection
        test_client.ping()
        redis_client = test_client
        use_redis = True
        print("✓ Redis client connected")
    except Exception as e:
        # Redis not available, use in-memory dict as fallback
        redis_client = None
        use_redis = False
        print(f"⚠️  Redis not available ({type(e).__name__}), using in-memory storage for OTP")
except ImportError:
    redis_client = None
    use_redis = False
    print("⚠️  Redis not installed, using in-memory storage for OTP")

class InMemoryRedis:
    """In-memory Redis replacement for local development"""
    def __init__(self):
        self._store = {}
    
    def get(self, key):
        return self._store.get(key)
    
    def setex(self, key, time, value):
        self._store[key] = value
        # Note: In real implementation, you'd want to handle expiration
    
    def delete(self, key):
        return self._store.pop(key, None)
    
    def ping(self):
        return True

def get_redis():
    """Dependency to get Redis client or in-memory fallback"""
    if redis_client is None:
        return InMemoryRedis()
    return redis_client
