"""AWS Lambda and private S3 adapter for exhausted local tasks."""
import json
import logging
import uuid

logger = logging.getLogger(__name__)


class CloudFallback:
    def __init__(self, region, function_name, bucket):
        if not (region and function_name and bucket):
            raise ValueError("AWS region, Lambda function, and S3 bucket are required")
        self.region = region
        self.function_name = function_name
        self.bucket = bucket

    def save_results_zip(self, job_id, data):
        """Keep a Cloud job's finished ZIP in the staging bucket until lifecycle expiry."""
        import boto3
        from botocore.config import Config

        key = f"edge-mesh/tasks/results/{job_id}/results.zip"
        s3 = boto3.client(
            "s3", region_name=self.region,
            config=Config(connect_timeout=5, read_timeout=30, retries={"total_max_attempts": 2}),
        )
        s3.put_object(Bucket=self.bucket, Key=key, Body=data,
                      ContentType="application/zip")
        return key

    def execute(self, data, filename, max_width, max_height):
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:
            raise RuntimeError("Install boto3 to enable AWS fallback") from exc
        task_id = uuid.uuid4().hex
        input_key = f"edge-mesh/tasks/{task_id}/input"
        output_key = f"edge-mesh/tasks/{task_id}/output"
        s3 = boto3.client(
            "s3", region_name=self.region,
            config=Config(connect_timeout=5, read_timeout=30, retries={"total_max_attempts": 2}),
        )
        lam = boto3.client(
            "lambda", region_name=self.region,
            # The function times out at 60s. Do not automatically invoke it
            # again on an ambiguous transport failure and spend credits twice.
            config=Config(connect_timeout=5, read_timeout=75, retries={"total_max_attempts": 1}),
        )
        try:
            s3.put_object(Bucket=self.bucket, Key=input_key, Body=data)
            response = lam.invoke(
                FunctionName=self.function_name,
                InvocationType="RequestResponse",
                Payload=json.dumps({
                    "bucket": self.bucket, "input_key": input_key,
                    "output_key": output_key, "filename": filename,
                    "max_width": max_width, "max_height": max_height,
                }).encode(),
            )
            with response["Payload"] as payload:
                result = json.load(payload)
            if response.get("FunctionError"):
                raise RuntimeError(result.get("errorMessage", "Lambda worker reported an execution error"))
            if result.get("statusCode", 200) >= 400:
                raise RuntimeError(result.get("error", "Lambda worker failed"))
            with s3.get_object(Bucket=self.bucket, Key=output_key)["Body"] as body:
                output = body.read()
            return output, result["size"], result["format"], result["processing_ms"]
        finally:
            # Cleanup must not hide the task's original error or discard a
            # valid result. Lifecycle expiration covers failed/late cleanup.
            try:
                deleted = s3.delete_objects(Bucket=self.bucket, Delete={
                    "Objects": [{"Key": input_key}, {"Key": output_key}], "Quiet": True,
                })
                if deleted.get("Errors"):
                    logger.warning("AWS task cleanup incomplete; S3 lifecycle expiration remains active: %s", deleted["Errors"])
            except Exception as exc:
                logger.warning("AWS task cleanup failed; S3 lifecycle expiration remains active: %s", exc)
