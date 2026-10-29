from functools import wraps
from flask import request, jsonify

def require_token(token):
    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            supplied = request.headers.get('X-Edge-Token') or request.args.get('token')
            if supplied != token:
                return jsonify({'error': 'invalid token'}), 401
            return fn(*args, **kwargs)
        return wrapped
    return decorator
