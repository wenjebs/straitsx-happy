# AWS deployment

Terraform provisions:

- private S3 frontend bucket with CloudFront origin access control;
- one CloudFront HTTPS origin for the frontend and uncached `/v1/*` API traffic;
- public ALB reachable only from the AWS-managed CloudFront origin prefix list;
- one ECS Fargate backend task with CloudWatch logs and outbound internet access;
- DynamoDB on-demand single table with point-in-time recovery;
- Cognito User Pool with verified-email signup and a public web client;
- ECR repository and a Secrets Manager secret.

When `funding_mode="chain"`, the backend also verifies inbound XSGD transfers through the
configured public Avalanche RPC and stores globally idempotent deposit records in the existing
DynamoDB table. `happy_wallet_address` is public configuration; the shared wallet's signing key
is not required for Stage 1 and must remain in the payment service used by Stage 2.

Fargate is used instead of API Gateway/Lambda because Happy keeps SSE streams open and calls
long-running browser/payment services. CloudFront waits up to 60 seconds between origin packets;
the backend writes an SSE heartbeat every 15 seconds. The ALB idle timeout is 120 seconds.

## Prerequisites

- Terraform 1.8+
- AWS CLI authenticated to the target account
- Docker
- Node 22 and Corepack/pnpm

Terraform uses a partial S3 backend configuration. Supply the account-specific bucket, key and
region during `terraform init`; do not commit them.

## GitHub Actions deployment

`.github/workflows/deploy-aws.yml` typechecks the workspace, tests the deployed application
packages, assumes an AWS role with GitHub OIDC, stores Terraform state in a protected/versioned S3
bucket, builds the backend into ECR, deploys it to ECS, builds the frontend against the CloudFront
URL, uploads it to S3, and verifies the public health endpoint. Pushes to `main` deploy `dev`; the
workflow can also be run manually for `dev` or `prod`.

Create a GitHub Environment named `dev` under **Settings → Environments**. Add these environment
variables:

| Variable | Required | Example / purpose |
|---|---:|---|
| `AWS_DEPLOY_ROLE_ARN` | yes | OIDC role the workflow can assume |
| `AWS_REGION` | no | `ap-southeast-1` |
| `TF_STATE_BUCKET` | yes | Globally unique S3 bucket name; the workflow creates and protects it |
| `TF_STATE_KEY` | no | `happy/dev/terraform.tfstate` |
| `TF_PROJECT_NAME` | no | `happy` |
| `FUNDING_MODE` | no | `chain` to enable Stage 1, otherwise `disabled` |
| `HAPPY_WALLET_ADDRESS` | for chain | Public shared-wallet address |
| `AGENT_API_BASE_URL` | no | Scout service URL when ready |
| `CARD_API_BASE_URL` | no | StraitsX card service URL when ready |
| `PURCHASE_AGENT_API_BASE_URL` | no | Closer service URL when ready |

The workflow also accepts optional `FUNDING_*`, `XSGD_ADDRESS`, and `OPENAI_MODEL` variables; its
defaults target Avalanche Fuji and the sandbox XSGD contract.

Add these encrypted GitHub Environment secrets. Empty integration tokens are permitted while the
corresponding service URL is unset, but every JSON key is still written to AWS Secrets Manager so
ECS can start consistently.

| Secret | Required |
|---|---:|
| `OPENAI_API_KEY` | yes |
| `AGENT_CALLBACK_TOKEN` | yes; stable random value of at least 32 characters |
| `WALLET_AUTH_SECRET` | when `FUNDING_MODE=chain`; stable random value of at least 32 characters |
| `AGENT_API_TOKEN` | when required by the Scout service |
| `CARD_API_TOKEN` | when required by the card service |
| `PURCHASE_AGENT_API_TOKEN` | when required by the Closer service |
| `PURCHASE_CALLBACK_TOKEN` | when `PURCHASE_AGENT_API_BASE_URL` is set |

In AWS IAM, add GitHub's OIDC provider (`https://token.actions.githubusercontent.com`, audience
`sts.amazonaws.com`) and create a role with this trust policy. Replace `AWS_ACCOUNT_ID` with your
AWS account number. This repository was created after GitHub's July 15, 2026 immutable-subject
rollout, so the `sub` below includes the verified GitHub owner and repository IDs. Because the
workflow uses GitHub Environments, the claim names the environment rather than the branch:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:wenjebs@107258917/straitsx-happy@1334723332:environment:*"
      }
    }
  }]
}
```

The deployment role needs permission to create/manage the resources in this Terraform stack plus
the configured state bucket. For a hackathon-only account, a temporary administrator deployment
role is the fastest bootstrap; restrict it to least privilege and narrow the environment claim
before production.

If this stack was already applied with local Terraform state, migrate that state into the S3
backend before the first workflow run. Starting the workflow against an empty state while those
resources already exist will cause duplicate-resource errors.

## 1. Bootstrap infrastructure

```powershell
Set-Location terraform
Copy-Item terraform.tfvars.example terraform.tfvars
terraform init `
  -backend-config='bucket=<STATE_BUCKET>' `
  -backend-config='key=happy/dev/terraform.tfstate' `
  -backend-config='region=ap-southeast-1' `
  -backend-config='encrypt=true' `
  -backend-config='use_lockfile=true'
terraform apply
```

The first apply leaves `deploy_backend=false`. It creates the ECR repository and secret before an
image or secret value is needed.

The deployed backend always uses Cognito authentication. Terraform outputs
`cognito_user_pool_id` and `cognito_web_client_id`; ECS receives both automatically. Local
development uses `AUTH_MODE=local` and does not require these AWS resources.

Populate the secret with all seven JSON keys. Use real random values—never commit this file:

```json
{
  "OPENAI_API_KEY": "replace-with-openai-project-key",
  "AGENT_API_TOKEN": "replace-with-agent-api-token",
  "AGENT_CALLBACK_TOKEN": "replace-with-a-long-random-value",
  "CARD_API_TOKEN": "replace-with-straitsx-card-api-token",
  "PURCHASE_AGENT_API_TOKEN": "replace-with-closer-api-token",
  "PURCHASE_CALLBACK_TOKEN": "replace-with-a-second-long-random-value",
  "WALLET_AUTH_SECRET": "replace-with-a-third-long-random-value"
}
```

```powershell
$secretArn = terraform output -raw backend_secret_arn
aws secretsmanager put-secret-value --secret-id $secretArn --secret-string file://backend-secrets.json
```

## 2. Build and deploy the backend

Run these from the repository root:

```powershell
$awsRegion = 'ap-southeast-1'
$repo = terraform -chdir=terraform output -raw backend_ecr_repository_url
$registry = $repo.Substring(0, $repo.IndexOf('/'))
$tag = (git rev-parse --short=12 HEAD)
$image = "${repo}:${tag}"

aws ecr get-login-password --region $awsRegion |
  docker login --username AWS --password-stdin $registry
docker build -f backend/Dockerfile -t $image .
docker push $image

terraform -chdir=terraform apply `
  -var='deploy_backend=true' `
  -var="backend_image=$image" `
  -var='agent_api_base_url=https://agent-api.example' `
  -var='card_api_base_url=https://card-api.example' `
  -var='purchase_agent_api_base_url=https://closer-api.example'
```

Use an image digest rather than a mutable tag for production once the workflow publishes one.

## 3. Build and deploy the frontend

```powershell
$appUrl = terraform -chdir=terraform output -raw app_url
$bucket = terraform -chdir=terraform output -raw frontend_bucket
$distribution = terraform -chdir=terraform output -raw cloudfront_distribution_id

$env:VITE_API_BASE_URL = $appUrl
$env:COREPACK_INTEGRITY_KEYS = '0' # only needed by older Corepack builds
corepack pnpm --filter @happy/frontend build
aws s3 sync frontend/dist "s3://$bucket" --delete
aws cloudfront create-invalidation --distribution-id $distribution --paths '/*'
```

Verify deployment:

```powershell
$health = terraform -chdir=terraform output -raw backend_health_url
Invoke-RestMethod $health
```

`blockers` must be empty before a real demo.

## Scaling note

ECS intentionally runs one task. Durable state is in DynamoDB, but active SSE fan-out is
process-local. Reconnects always receive a fresh snapshot, so replacement is safe, but horizontal
scaling needs a shared event bus (for example Redis/ElastiCache or a dedicated WebSocket/SSE fanout
service) before increasing desired count.
