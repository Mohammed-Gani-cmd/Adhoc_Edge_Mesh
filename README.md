# Ad Hoc Edge Mesh

An image resizing demo that processes jobs either on Windows/Linux laptops and foreground Android/iOS phone workers on the same trusted LAN, or directly on AWS Lambda with private S3 staging. Each coordinator starts in Mesh mode. Cloud mode is available only when AWS is configured and is selected on the coordinator laptop.

## Features

- mDNS discovery for laptop nodes and manual `--peer IP:PORT` registration when multicast is blocked.
- React Native worker/dashboard app for Android and iOS. Phones poll the laptop coordinator over outbound HTTP; keep the app open while it contributes compute.
- Allocation score: available CPU 40%, free memory 15%, inverse RTT 25%, historical reliability 20%, with an in-flight work penalty.
- JPEG, PNG, and WebP image resizing with EXIF orientation correction, aspect ratio preservation, and no upscaling.
- Failed mesh tasks retry on a different node and never call AWS. Cloud jobs send every image directly to AWS and never assign one to a mesh device.
- ZIP results include a manifest with assignment, execution location, attempts, dimensions, and processing time.
- Shared demo token protects laptop and phone worker endpoints. Use only on a trusted LAN.

## Laptop setup

Extract the project ZIP, open a terminal in the project root (the folder containing `requirements.txt`), and run all backend commands there. Python 3.11 or newer is required on every laptop. A single laptop is enough to start; other laptops, phones, and AWS are optional.

```bash
python -m venv .venv
```

Activate the environment, then install dependencies:

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Linux/macOS:

```bash
source .venv/bin/activate
python -m pip install -r requirements.txt
```

For Windows Command Prompt use `.venv\Scripts\activate.bat`. If PowerShell blocks activation, run `.\.venv\Scripts\python.exe` in place of `python`; activation is optional when using the environment's interpreter directly.

Start a coordinator/worker (no AWS account or credentials required):

```bash
python -m edge_mesh --name Laptop-1 --port 5000 --token demo123
```

Other laptops can connect using `--peer <coordinator-lan-ip>:5000`, for example:

```bash
python -m edge_mesh --name Laptop-2 --port 5001 --token demo123 --peer 192.168.1.10:5000
```

Open `http://127.0.0.1:5000` on the coordinator laptop. Allow the selected TCP ports through the trusted/private network firewall. mDNS uses local multicast; manual peers are available if multicast is blocked.

### Build or develop the React dashboard

Without a frontend build, the coordinator serves the bundled HTML dashboard. To use the React dashboard, install Node.js 22.13 or newer with npm, then run:

```bash
cd frontend
npm ci
npm run build
cd ..
```

Start the coordinator with the command above and open `http://127.0.0.1:5000`. Flask serves the built dashboard and API together; you do not need a separate frontend server. Rebuild and reload after changing frontend code.

For frontend development, keep the Python coordinator running on port 5000 and run `npm run dev` from `frontend/` in another terminal. Open `http://localhost:5173`; Vite proxies `/api` to port 5000.

### Run a small demo

With the Python environment active, generate sample inputs from the project root:

```bash
python generate_demo_images.py --count 10
```

Choose the generated images from `demo_images/` in the dashboard, set maximum dimensions, and submit. Monitor assigned nodes and attempts, then download the results ZIP and inspect `manifest.json`. Join another laptop or a foreground phone worker to demonstrate distribution. Stop each server with **Ctrl+C**. Restarting the coordinator clears its in-memory job history.

The laptop dashboard's **Recent jobs from all devices** selector discovers phone and browser submissions automatically, including jobs that finish between polls. It initially selects the newest job, then preserves your selection when other devices submit work. A new browser upload selects its own job. Choose another job to inspect its progress, attempts, and ZIP results; **Refresh jobs** retries failed requests. The built React dashboard and bundled HTML fallback both support this behavior.

The selector lists the latest 50 jobs in coordinator memory. A selected older job remains accessible through its detail endpoint. Browser reloads discover the current list again; restarting the coordinator clears job history and makes old job URLs unavailable. Phone/browser source labels describe client-supplied submission metadata, not an authenticated identity. After updating this feature, rebuild the web frontend and restart the coordinator; reload the mobile app so new phone submissions carry the `mobile` label. Earlier clients' submissions still appear with **Unknown source**.

## Phone setup

Install Node.js 22.13 or newer **with npm** (`node --version` and `npm --version` must both work). Keep the laptop coordinator running, then in a second terminal from `mobile/`:

```bash
npm ci
npm start
```

After installing dependencies, start Expo Go from the repository root with `./run_expo_go.sh` on Linux/macOS or `run_expo_go.bat` on Windows. Both scripts start Metro on the LAN at port 8082 and accept extra Expo flags, such as `--clear`.

Use **Expo Go for SDK 58** on each phone. This project targets SDK 58; SDK 57 Expo Go cannot run it. On a physical iPhone, the App Store provides only the current Expo Go SDK, so an older iOS Expo Go is not a workaround for a version mismatch. Keep the project and Expo Go on matching SDK versions using [Expo's upgrade workflow](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/). This app uses modules included in Expo Go, including [native file sharing](https://docs.expo.dev/versions/v58.0.0/sdk/sharing/). Open the fresh terminal QR code using Expo Go on Android or the Camera app on iPhone.

Find the coordinator laptop's Wi-Fi IPv4 address in its network settings (`ip -4 addr` on Linux, `ipconfig` on Windows, or `ipconfig getifaddr en0` on macOS). Enter that LAN URL, for example `http://192.168.1.10:5000`, rather than `localhost`. First open that URL in the phone browser to confirm reachability, then tap **Check connection** in the app. Enter the token passed to the coordinator (`demo123` in the example) and tap **Join mesh as worker**. Connection checking verifies reachability and protocol; joining also verifies the worker token.

Both phones and the laptop must use the same reachable Wi-Fi/LAN. The mobile start scripts use **TCP 8082** for Expo Metro; the coordinator uses **TCP 5000**. Allow these ports through the laptop firewall on the trusted network. To start without npm when dependencies are already installed, run `node node_modules/expo/bin/cli start --lan --port 8082` from `mobile/`. Stop older Metro instances before starting a new one; after an SDK upgrade, add `--clear` and scan the new QR code. Confirm reachability in the phone browser at `http://<laptop-ip>:8082/status`, which should display `packager-status:running`. Guest Wi-Fi/client isolation can prevent device-to-device traffic. An Expo tunnel only exposes Metro; it does not expose the coordinator API. On iPhone, allow Expo Go's Local Network permission; if previously denied, enable it in Settings. Accept photo access if requested, or choose images through the system picker. Cancelling selection is safe.

Keep the app foregrounded while contributing compute. **Pause worker**, leaving the foreground, or a lost worker connection ends the session and requires an explicit rejoin. Opening another app, the photo picker, or a share sheet may pause the worker too. Connection settings remain locked until the worker disconnects. The coordinator releases withdrawn tasks for retry on another available worker. If withdrawal cannot reach the coordinator, its 15-second worker liveness timeout applies to availability; an already assigned task can take up to its 60-second timeout to retry.

Use **Choose images and submit** for up to 100 images/100 MB. The app converts inputs to JPEG and submits a 1280 × 720 maximum-size job; worker resizing preserves aspect ratio and never upscales. Completed jobs expose **Save or share ZIP** using the native Android/iOS share sheet. On iPhone choose Save to Files; on Android choose an installed file-saving/share destination. Job monitoring and downloads keep using the coordinator that accepted that job, even if you later change the connection URL. After a polling error, tap **Refresh related jobs** to retry.

The mobile dashboard separates **phone attempts** from **overall jobs**. If an iPhone upload fails and the laptop retries successfully, activity shows the phone failure alongside the image's eventual completion on the laptop. A result upload with a missing acknowledgement remains **Confirmation pending** until the coordinator's attempt history resolves it. Only coordinator-accepted phone results increment the accepted count; successful laptop retries do not. Uploads use native `File` objects with `expo/fetch`, rather than URI objects cast as blobs.

The worker card shows download/resize/upload/confirmation stages, session counts, online time, polling latency, last contact, and memory estimates. Related jobs include work assigned to this phone from the laptop as well as batches submitted from the phone. Expand a job to inspect image dimensions, execution location, timing, and attempt errors. Use **Refresh related jobs** after a connection problem. The app keeps the latest 20 phone attempts and 10 related jobs in memory while open. Settings remain locked while joined; pause before changing them. Restart the coordinator after updating it so phone task assignments include job links. Jobs are kept in coordinator memory, so a coordinator restart makes earlier job URLs unavailable.

The Android native manifest explicitly enables HTTP for this trusted-LAN demo through a local Expo config plugin. iOS includes local-network and photo privacy descriptions and a local ATS exception. Expo Go uses its own native configuration; if you need to validate this app's native configuration or Expo Go blocks LAN HTTP, install a native build. On a machine with Android SDK tooling use `npx expo run:android --device`; on macOS with Xcode use `npx expo run:ios --device`. Native configuration changes require rebuilding the native app. No cloud build or app-store deployment is needed for the Expo Go workflow.

### Phone acceptance checks

Automated checks and bundle exports do not replace physical-device testing. Run these checks on **both Android and iPhone**, recording the phone/OS version and Expo Go or native-build version. Both device runs remain pending until performed.

1. Open the laptop URL in the phone browser; check the connection in the app. Try an incorrect token and confirm a visible rejection, then join with the correct token. Confirm the phone appears in the laptop dashboard.
2. Submit JPEG, PNG, WebP, a portrait/EXIF-rotated image, and an image smaller than the resize bounds. Confirm a task actually executes on the phone: the app reports the processed filename and the dashboard/ZIP manifest reports `execution_location: mobile`. Increase the batch to occupy laptop capacity if all initial tasks run on the laptop.
3. Submit images from the phone, cancel the picker once, then submit successfully. Monitor to completion and save/share the ZIP. Inspect its images and `manifest.json`: dimensions fit the bounds, aspect ratio/orientation are correct, and small inputs are not enlarged. HEIC/photo-library inputs should normalize to JPEG on each device that supports them.
4. Pause during assigned work and confirm prompt removal and retry on another available worker. Rejoin repeatedly and confirm there is only one phone entry and no duplicate processing.
5. Background/foreground the app, interrupt Wi-Fi, and restart the coordinator. Confirm clear errors, no continuing worker session, and successful explicit rejoin after connectivity returns. Submit a new job after a coordinator restart; old jobs are stored only in memory.

Current automated validation covers session cancellation, error paths, limits, file cleanup, generated native networking settings, mobile HTTP task/result exchange, withdrawal/local retry, and ZIP contents. Native decoding, permissions, share destinations, and actual LAN reachability require the device runs above.

## Mesh / Cloud mode switch

Open `http://127.0.0.1:5000` or `http://localhost:5000` on the coordinator laptop to choose the mode for new jobs. The Cloud button and current state appear in the dashboard header. Mode changes require a local browser request; the button is disabled when viewing from another device. Mesh is selected after every restart. Switching to Cloud asks for confirmation because every image in each new job invokes AWS. The switch does not submit a sample job. Phone and browser uploads share the same coordinator mode; each job retains its mode if the switch changes while it runs. Existing upload limits still apply. `/api/v1/status` reports `execution_mode`, and job details and recent jobs report each job's `execution_mode`.

Cloud requires `EDGE_CLOUD_ENABLED=true` and the configured AWS resources. Cloud failures fail the affected image without mesh retry. Mesh failures never invoke AWS. The isolated `scripts.demo_cloud_fallback` diagnostic described below is a separate adapter exercise and does not change coordinator mode or create a dashboard job.

Cloud jobs also save their results ZIP to the configured private S3 bucket at `edge-mesh/tasks/results/<job-id>/results.zip` when at least one image succeeds. The ZIP contains successful images and the existing manifest, including when other images failed. Mesh jobs never upload a results ZIP. Job details on the web and phone show the S3 save status and object location. If S3 saving fails, the local ZIP remains available and the processing result is unchanged. The dashboard still loses job history on coordinator restart; use the S3 console to find retained ZIPs. Confirm the bucket's lifecycle rule expires the `edge-mesh/tasks/results/` prefix after two days. The coordinator's IAM identity does not have permission to inspect lifecycle configuration; expiration must be checked in the S3 console. S3 lifecycle expiration is asynchronous.

To verify retention, open the configured bucket in the S3 console, choose **Management → Lifecycle rules**, and confirm an enabled rule covering `edge-mesh/tasks/` or `edge-mesh/tasks/results/` expires current objects after two days. If that rule is absent, add it with an account identity allowed to manage bucket lifecycle before relying on automatic deletion.

## Optional AWS configuration

### Free account and execution mode

Keep `EDGE_CLOUD_ENABLED=false` (the default) for everyday edge mesh demonstrations. Existing resource names or AWS credentials alone do **not** enable cloud execution. Enabling AWS makes Cloud selectable on the local coordinator dashboard; it does not select Cloud after a restart. Mesh jobs wait for busy untried workers and retry other eligible nodes. If none can complete an image, that image fails without an AWS call.

This setup does not change your AWS account plan. Check the actual plan, remaining credits, and expiration in AWS Billing before deploying. AWS's Free account plan ends after six months or when credits are exhausted, whichever comes first; a Paid account plan can incur charges beyond credits. See [AWS account plan details](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html) and [Free Tier FAQs](https://aws.amazon.com/free/free-tier-faqs/). Cleanup and limited logs reduce usage; they do not enforce a billing cap or guarantee zero cost.

The application stack contains one Lambda worker, one private staging bucket, IAM permissions, and a log group with three-day retention. There are no public Lambda URLs, API Gateway, EC2 instances, or databases. S3 encrypts images at rest and blocks public access. Each task requests deletion of its input and output on success or failure; two-day S3 lifecycle expiration covers missed cleanup, including late output after a connection failure. Expiration is asynchronous. Lambda invocation has no automatic SDK retry, avoiding duplicate invocations after ambiguous network errors.

### Deploy to an AWS account

No resources are deployed just by installing or starting this project. Deployment requires [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html). Docker is recommended for the Linux/Python 3.12 image build because Pillow has native libraries; see [SAM container builds](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-using-build.html). On a Linux x86_64 host with Python 3.12, `sam build` without Docker is also possible; this project's native build was validated locally. Run the live verification below before relying on a native-built Lambda package.

Use a non-root deployment identity with CloudFormation, Lambda, S3, IAM, and CloudWatch Logs deployment permissions. Configure credentials locally using a named profile (or your organization's existing SSO profile). Never put access keys in source files, the dashboard, or chat:

```bash
aws configure --profile edge-mesh-deploy
aws sts get-caller-identity --profile edge-mesh-deploy
sam validate --region ap-south-1
sam build --use-container
sam deploy --guided --stack-name edge-mesh-fallback --region ap-south-1 --profile edge-mesh-deploy
```

In guided deployment, review the change set and allow creation of the template's IAM resources. SAM may also create a deployment artifact bucket outside this application stack; it stores the packaged Lambda code. See [SAM deployment options](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-cli-command-reference-sam-deploy.html). Generated `.aws-sam/` and `samconfig.toml` are ignored by Git.

Read the deployed names:

```bash
aws cloudformation describe-stacks --stack-name edge-mesh-fallback --region ap-south-1 --profile edge-mesh-deploy --query 'Stacks[0].Outputs' --output table
```

Outputs include `FunctionName`, `StagingBucketName`, and `CoordinatorPolicyArn`. Attach the provided managed policy to the IAM user or role used by the coordinator, then configure that identity locally as profile `edge-mesh`. It grants only `lambda:InvokeFunction` on this function and `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` under this bucket's `edge-mesh/tasks/` prefix. It does not grant deployment permissions. Other mesh laptops and phones need no AWS credentials.

### Enable, verify, and start

Set the output values on the coordinator terminal. These settings are read from the process environment; `.env` files are not automatically loaded.

Linux/macOS:

```bash
export AWS_PROFILE=edge-mesh
export AWS_REGION=ap-south-1
export EDGE_LAMBDA_FUNCTION=replace-with-FunctionName-output
export EDGE_S3_BUCKET=replace-with-StagingBucketName-output
export EDGE_CLOUD_ENABLED=true
python -m scripts.check_aws
python -m edge_mesh --name Laptop-1 --port 5000 --token demo123
```

Windows PowerShell:

```powershell
$env:AWS_PROFILE = "edge-mesh"
$env:AWS_REGION = "ap-south-1"
$env:EDGE_LAMBDA_FUNCTION = "replace-with-FunctionName-output"
$env:EDGE_S3_BUCKET = "replace-with-StagingBucketName-output"
$env:EDGE_CLOUD_ENABLED = "true"
python -m scripts.check_aws
python -m edge_mesh --name Laptop-1 --port 5000 --token demo123
```

`python -m scripts.check_aws` is offline: it checks the enable flag and required settings without contacting AWS or validating credentials. With cloud enabled, missing settings cause an explicit startup error. Mumbai is the default region if neither `AWS_REGION` nor `AWS_DEFAULT_REGION` is supplied. `EDGE_CLOUD_WAIT_SECONDS` has been retired and no longer sends busy edge work to AWS.

On Linux, you can persist the non-secret settings in a local `.env.aws` file using the variable names above. `./run_laptop1.sh` loads that file and starts the coordinator with cloud enabled. The file is ignored by Git and excluded from the project ZIP; keep AWS credentials in the CLI profile, never in `.env.aws`. Running `python -m edge_mesh` directly still requires the environment variables to be exported in that terminal.

For one **live** check after deployment, using the same configured terminal:

```bash
python -m scripts.check_aws --live
```

This explicitly uploads a tiny generated PNG, invokes Lambda once, checks resizing from 16 × 8 to 8 × 4, and requests temporary-object cleanup. It consumes AWS requests/credits and bypasses the coordinator job mode solely to verify the AWS adapter. It does not create a dashboard job. Automated tests cover direct cloud routing, mesh isolation, attempt history, and ZIP attribution without consuming credits.

To exercise the isolated legacy fallback diagnostic on a deployed setup without interrupting the normal coordinator, run this from the project root:

```bash
.venv/bin/python -m scripts.demo_cloud_fallback --live
```

The demo reads this laptop's `.env.aws` if present, simulates one local resize failure in an isolated job, and sends one tiny PNG through the configured AWS fallback. It prints the cloud assignment and writes `edge_mesh_data/cloud_demo_results.zip` with `execution_location: cloud` in its manifest. It consumes one Lambda invocation and S3 requests. The simulated job does not appear in the running dashboard and does not change normal job scheduling.

The dashboard and `/api/v1/status` report the selected mode. `cloud_fallback_enabled` means AWS is configured, not verified connectivity or available credits. Cloud attempts appear as **AWS Lambda**, and successful outputs have `execution_location: cloud` in the ZIP manifest. Expand an image's attempt details to inspect errors. Access denial or expired credentials cause cloud images to fail visibly.

To disable cloud, set `EDGE_CLOUD_ENABLED=false` (`$env:EDGE_CLOUD_ENABLED = "false"` in PowerShell) and restart the coordinator. This prevents new AWS calls from the app; it does not remove deployed resources or cancel an already running invocation.

### Remove deployed resources

After stopping cloud-enabled coordinators, detach `CoordinatorPolicyArn` from any IAM identities so CloudFormation can remove the managed policy. If you removed deployment permissions from the IAM identity after setup, restore them temporarily before deleting or updating the stack. From the project root, use the deployment profile:

```bash
sam delete --stack-name edge-mesh-fallback --region ap-south-1 --profile edge-mesh-deploy
```

Review SAM's deletion prompts. If deletion reports a nonempty staging bucket, empty **only the stack's `StagingBucketName` bucket** in the S3 console, then retry. Verify the stack and its log group were deleted. Check for packaged artifacts in SAM's deployment bucket; remove this project's unused artifacts, and keep shared deployment resources used by other stacks.

## Data retention

Job inputs, outputs, and reliability history are stored under `edge_mesh_data/`. Preview cleanup of job folders older than seven days:

```bash
python scripts/cleanup_data.py --retention-days 7 --dry-run
```

Remove the listed folders by omitting `--dry-run`. Reliability history is kept in `edge_mesh_data/node_stats.json` and is not removed by the job cleanup command.

## API

- `GET /api/v1/status` — node identity, CPU, memory, capacity, in-flight tasks, reliability, protocol version, AWS configuration, and current execution mode.
- `POST /api/v1/execution-mode` — local coordinator browser only; JSON `{"execution_mode":"mesh"}` or `{"execution_mode":"cloud"}`.
- `GET /api/v1/peers` — current laptop and mobile worker status.
- `GET /api/v1/jobs` — `{ "jobs": [...] }` with the latest 50 job summaries, newest first: `job_id`, `created_at`, `submitted_from`, `status`, `item_count`, `completed_count`, and `failed_count`.
- `POST /api/v1/jobs` — multipart image submission; optional `max_width`, `max_height`, and `submitted_from` (`mobile` or `web`, otherwise `unknown`). The source is also returned in job details.
- `GET /api/v1/jobs/<job_id>` — job state, assignment, attempt history, and execution location.
- `GET /api/v1/jobs/<job_id>/download` — ZIP results and manifest.
- `POST /api/v1/tasks/resize` — authenticated laptop-to-laptop worker request.
- `POST /api/v1/mobile/workers/register` — authenticated phone worker registration.
- `DELETE /api/v1/mobile/workers/<worker_id>` — authenticated, idempotent withdrawal; releases outstanding phone tasks for retry.
- `GET /api/v1/mobile/workers/<worker_id>/tasks/next` — phone heartbeat and task poll.
- `POST /api/v1/mobile/workers/<worker_id>/heartbeat` — phone liveness while processing.
- `GET /api/v1/mobile/workers/<worker_id>/tasks/<task_id>/input` — assigned task input.
- `POST /api/v1/mobile/workers/<worker_id>/tasks/<task_id>/result` — resized phone worker output.

Worker APIs require `X-Edge-Token` matching the coordinator token. Mobile worker protocol version is 1.1. Phone workers poll and receive task data through the coordinator; phones do not listen for inbound LAN connections. Mobile total memory comes from the device API, free memory is estimated, CPU load is currently reported as idle, and RTT is measured from coordinator polling. A random installation ID stored in phone secure storage lets the coordinator retain that worker’s reliability history across app restarts. AWS is separately controlled by `EDGE_CLOUD_ENABLED`; it never runs solely because untried edge workers are busy.

For protocol 1.1, registration accepts JSON fields `name`, `platform`, `client_id`, `capacity`, `cpu_percent`, `free_memory_mb`, and `total_memory_mb`. Task polling returns HTTP 204 when idle or JSON containing `task_id`, `filename`, `max_width`, `max_height`, and the additive `job_id`/`item_id` links. Older phone clients can ignore the extra fields; newer clients tolerate old assignments without them but cannot reconcile or display those related jobs. The input endpoint returns the source image bytes. The result endpoint accepts multipart `image` and `processing_ms` fields; the coordinator validates the returned image format and dimensions before aggregation. Workers report task errors to the matching `/fail` endpoint.

## Development checks

Run Python tests with `.venv/bin/python -m pytest -q`. Build the web frontend from `frontend/` with `npm ci` and `npm run build`. From `mobile/`, run `npm ci`, `npm test`, `npm run typecheck`, `npx expo install --check`, and `npm run bundle:check`. Mobile tests use Node's TypeScript stripping and inspect the generated native configuration without requiring Android SDK or Xcode. The bundle check exports Android and iOS Hermes bundles to ignored `mobile/dist/`; it does not compile native applications. Expo's dependency check can fall back to its installed SDK map when offline.

For browser job-discovery regression checks, build the frontend, start `.venv/bin/python tests/browser_jobs_server.py` in one terminal, and run `node tests/browser_jobs.mjs` from the root in another. This uses installed Chromium, a temporary loopback coordinator on port 5505, and an isolated browser profile/debugging port 9225. It exercises both dashboards with phone submissions, actual browser uploads, rapid selection changes, network failures, older jobs, and lost coordinator history. Stop the temporary server afterward.

Real-device checks should include Android and iOS on the same Wi-Fi, phone worker registration and task completion, job submission from a phone, interruption while a phone task is assigned, local retry, and an AWS fallback run with deployed credentials.

## Limitations

Phone workers run only while the app is open. This demo uses HTTP and a shared LAN token; use it only on a trusted network. It does not provide user accounts, public internet traversal, durable job storage, or production authentication.
