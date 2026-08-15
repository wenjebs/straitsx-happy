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
