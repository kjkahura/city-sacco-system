"""
Redis client configuration
"""

import redis
from app.core.config import settings

# Create Redis client
redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)

def get_redis():
    """Dependency to get Redis client"""
    return redis_client
