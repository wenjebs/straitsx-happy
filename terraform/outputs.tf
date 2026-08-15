output "app_url" {
  description = "CloudFront URL used by both the browser and agent callback."
  value       = "https://${aws_cloudfront_distribution.app.domain_name}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.app.id
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.id
}

output "backend_ecr_repository_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "backend_secret_arn" {
  value = aws_secretsmanager_secret.backend.arn
}

output "dynamodb_table" {
  value = aws_dynamodb_table.happy.name
}

output "backend_health_url" {
  value = "https://${aws_cloudfront_distribution.app.domain_name}/v1/health"
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.happy.id
}

output "cognito_web_client_id" {
  value = aws_cognito_user_pool_client.happy_web.id
}
