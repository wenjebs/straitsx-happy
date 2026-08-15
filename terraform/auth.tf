resource "aws_cognito_user_pool" "happy" {
  name = "${local.name}-users"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    require_uppercase                = true
    temporary_password_validity_days = 3
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    attribute_data_type = "String"
    mutable             = true
    name                = "name"
    required            = true

    string_attribute_constraints {
      min_length = 2
      max_length = 80
    }
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Confirm your Happy account"
    email_message        = "Your Happy confirmation code is {####}."
  }

  deletion_protection = var.environment == "prod" ? "ACTIVE" : "INACTIVE"
  tags                = local.common_tags
}

resource "aws_cognito_user_pool_client" "happy_web" {
  name         = "${local.name}-web"
  user_pool_id = aws_cognito_user_pool.happy.id

  generate_secret                               = false
  prevent_user_existence_errors                 = "ENABLED"
  enable_token_revocation                       = true
  explicit_auth_flows                           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity                         = 1
  id_token_validity                             = 1
  refresh_token_validity                        = 30
  auth_session_validity                         = 3
  enable_propagate_additional_user_context_data = false

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
