from dataclasses import dataclass, field
import os


def _cloud_enabled():
    value = os.getenv('EDGE_CLOUD_ENABLED', 'false').strip().lower()
    if value not in {'', '0', 'false', 'no', 'off', '1', 'true', 'yes', 'on'}:
        raise ValueError('EDGE_CLOUD_ENABLED must be true or false')
    return value in {'1', 'true', 'yes', 'on'}


@dataclass
class Config:
    name: str = os.getenv('EDGE_NAME', 'Laptop')
    token: str = os.getenv('EDGE_TOKEN', 'demo-token')
    host: str = '0.0.0.0'
    port: int = int(os.getenv('EDGE_PORT', '5000'))
    max_images: int = 100
    max_total_bytes: int = 100 * 1024 * 1024
    protocol_version: str = '1.1'
    service_type: str = '_adhoc-edge._tcp.local.'
    cloud_enabled: bool = field(default_factory=_cloud_enabled)
    aws_region: str = field(default_factory=lambda: os.getenv('AWS_REGION', os.getenv('AWS_DEFAULT_REGION', 'ap-south-1')).strip())
    lambda_function_name: str = field(default_factory=lambda: os.getenv('EDGE_LAMBDA_FUNCTION', '').strip())
    s3_bucket: str = field(default_factory=lambda: os.getenv('EDGE_S3_BUCKET', '').strip())
    data_retention_days: int = int(os.getenv('EDGE_DATA_RETENTION_DAYS', '7'))

    def validate_cloud(self):
        if not self.cloud_enabled:
            return
        missing = [name for name, value in (
            ('AWS_REGION', self.aws_region),
            ('EDGE_LAMBDA_FUNCTION', self.lambda_function_name),
            ('EDGE_S3_BUCKET', self.s3_bucket),
        ) if not value]
        if missing:
            raise ValueError('AWS fallback is enabled but missing: ' + ', '.join(missing))
