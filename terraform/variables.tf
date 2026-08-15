variable "project_name" {
  description = "Short name used in AWS resource names."
  type        = string
  default     = "happy"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region for regional resources."
  type        = string
  default     = "ap-southeast-1"
}

variable "deploy_backend" {
  description = "Create the ECS task definition and service after an image and secret value exist."
  type        = bool
  default     = false
}

variable "backend_image" {
  description = "Immutable backend container image URI, ideally with a digest. Required when deploy_backend=true."
  type        = string
  default     = ""

  validation {
    condition     = !var.deploy_backend || length(var.backend_image) > 0
    error_message = "backend_image is required when deploy_backend=true."
  }
}

variable "backend_cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 512
}

variable "backend_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 1024
}

variable "agent_api_base_url" {
  description = "Remote real-agent API base URL. Leave empty until provided."
  type        = string
  default     = ""
}

variable "openai_model" {
  description = "OpenAI model used by Happy's wishlist planner."
  type        = string
  default     = "gpt-5.6-luna"
}

variable "card_api_base_url" {
  description = "Remote StraitsX card API base URL. Leave empty until provided."
  type        = string
  default     = ""
}

variable "purchase_agent_api_base_url" {
  description = "Remote Closer browser-agent API base URL. Leave empty until provided."
  type        = string
  default     = ""
}

variable "funding_mode" {
  description = "Inbound XSGD funding verifier mode: disabled or chain."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "chain"], var.funding_mode)
    error_message = "funding_mode must be disabled or chain."
  }
}

variable "happy_wallet_address" {
  description = "Public Avalanche address of Happy's shared, pre-funded wallet."
  type        = string
  default     = ""

  validation {
    condition     = var.happy_wallet_address == "" || can(regex("^0x[0-9a-fA-F]{40}$", var.happy_wallet_address))
    error_message = "happy_wallet_address must be blank or a 20-byte EVM address."
  }
}

variable "funding_chain_id" {
  description = "Avalanche chain id used for inbound XSGD funding."
  type        = number
  default     = 43113
}

variable "funding_rpc_url" {
  description = "Public Avalanche JSON-RPC endpoint used to verify deposits."
  type        = string
  default     = "https://api.avax-test.network/ext/bc/C/rpc"
}

variable "xsgd_address" {
  description = "XSGD token contract on the configured funding chain."
  type        = string
  default     = "0xd769410dc8772695a7f55a304d2125320a65c2a5"

  validation {
    condition     = can(regex("^0x[0-9a-fA-F]{40}$", var.xsgd_address))
    error_message = "xsgd_address must be a 20-byte EVM address."
  }
}

variable "funding_network_name" {
  description = "Wallet-facing funding network name."
  type        = string
  default     = "Avalanche Fuji C-Chain"
}

variable "funding_explorer_url" {
  description = "Block explorer base URL for funding receipts."
  type        = string
  default     = "https://subnets-test.avax.network/c-chain"
}

variable "deposit_confirmations" {
  description = "Confirmations required before crediting an XSGD deposit."
  type        = number
  default     = 1

  validation {
    condition     = var.deposit_confirmations >= 1 && var.deposit_confirmations <= 100
    error_message = "deposit_confirmations must be between 1 and 100."
  }
}

variable "payment_min_minor" {
  description = "Smallest issuable card amount in SGD cents."
  type        = number
  default     = 500
}

variable "payment_max_minor" {
  description = "Largest issuable card amount in SGD cents."
  type        = number
  default     = 3000
}

variable "payment_attempts_per_listing" {
  description = "Idempotent attempts before moving to a lower/equal-price alternate."
  type        = number
  default     = 2
}

variable "cloudfront_price_class" {
  description = "CloudFront edge footprint. PriceClass_200 covers Singapore and nearby regions."
  type        = string
  default     = "PriceClass_200"
}

variable "issuer_mode" {
  description = "@happy/pay issuer. straitsx mints a real single-use card and needs SPEND_PRIVATE_KEY; mock spends nothing."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "straitsx"], var.issuer_mode)
    error_message = "issuer_mode must be mock or straitsx."
  }
}

variable "straitsx_card_api_base" {
  description = "StraitsX card API. The sandbox path issues testnet cards; production spends real money."
  type        = string
  default     = "https://card.straitsx.ai/sandbox/cardapi"
}

variable "cardholder_name" {
  description = "Name embossed on the issued card."
  type        = string
  default     = "Happy Agent"
}
