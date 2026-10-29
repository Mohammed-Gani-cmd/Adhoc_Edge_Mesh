"""Check cloud configuration offline, or explicitly run one tiny AWS resize.

From the project root: python -m scripts.check_aws [--live]
"""
import argparse
from io import BytesIO

from PIL import Image

from edge_mesh.cloud_fallback import CloudFallback
from edge_mesh.config import Config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Upload a tiny PNG and invoke AWS Lambda once (uses AWS credits)')
    args = parser.parse_args()
    try:
        cfg = Config()
        cfg.validate_cloud()
    except ValueError as exc:
        parser.error(str(exc))
    if not cfg.cloud_enabled:
        if args.live:
            parser.error('Set EDGE_CLOUD_ENABLED=true and configure AWS before using --live')
        print('AWS fallback is disabled. No AWS calls made.')
        return
    print(f'AWS fallback configured in {cfg.aws_region}; busy edge workers always wait locally.')
    if not args.live:
        print('Offline check only. Credentials and deployed resources have not been verified.')
        return
    source = BytesIO()
    Image.new('RGB', (16, 8), 'white').save(source, format='PNG')
    try:
        cloud = CloudFallback(cfg.aws_region, cfg.lambda_function_name, cfg.s3_bucket)
        output, size, fmt, _ = cloud.execute(source.getvalue(), 'aws-check.png', 8, 8)
        with Image.open(BytesIO(output)) as image:
            image.load()
            if image.format != 'PNG' or image.size != (8, 4) or list(size) != [8, 4] or fmt != 'PNG':
                raise ValueError('Unexpected cloud resize output')
    except Exception as exc:
        parser.exit(1, f'AWS verification failed: {exc}\n')
    print('Live AWS resize passed: PNG 16 x 8 -> 8 x 4. Temporary S3 cleanup requested.')
    print('This checks the AWS adapter directly; it does not submit an edge mesh job.')


if __name__ == '__main__':
    main()
