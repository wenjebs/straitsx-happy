resource "aws_lb" "backend" {
  name               = substr("${local.name}-backend", 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  idle_timeout       = 120

  enable_deletion_protection = false
  drop_invalid_header_fields = true

  tags = local.common_tags
}

resource "aws_lb_target_group" "backend" {
  name        = substr("${local.name}-backend", 0, 32)
  port        = 8787
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/v1/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 20
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "backend" {
  load_balancer_arn = aws_lb.backend.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${local.name}/backend"
  retention_in_days = 30
  tags              = local.common_tags
}

resource "aws_ecs_task_definition" "backend" {
  count = var.deploy_backend ? 1 : 0

  family                   = "${local.name}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.backend_cpu)
  memory                   = tostring(var.backend_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.backend_task.arn

  container_definitions = jsonencode([{
    name      = "backend"
    image     = var.backend_image
    essential = true
    portMappings = [{
      containerPort = 8787
      hostPort      = 8787
      protocol      = "tcp"
    }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "8787" },
      { name = "DATA_STORE", value = "dynamodb" },
      { name = "DYNAMODB_TABLE", value = aws_dynamodb_table.happy.name },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "FRONTEND_ORIGIN", value = "https://${aws_cloudfront_distribution.app.domain_name}" },
      { name = "PUBLIC_BASE_URL", value = "https://${aws_cloudfront_distribution.app.domain_name}" },
      { name = "AUTH_MODE", value = "cognito" },
      { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.happy.id },
      { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.happy_web.id },
      { name = "PLANNER_MODE", value = "openai" },
      { name = "OPENAI_MODEL", value = var.openai_model },
      { name = "OPENAI_BASE_URL", value = "https://api.openai.com/v1" },
      { name = "SCOUT_MODE", value = var.agent_api_base_url != "" ? "remote" : "agentcore" },
      { name = "AGENT_API_BASE_URL", value = var.agent_api_base_url },
      # The Closer runs as a sidecar in this same task, so the backend reaches it on loopback:
      # awsvpc gives both containers one network namespace.
      { name = "ALLOW_MOCK_MONEY", value = "false" },
      { name = "CARD_MODE", value = var.card_api_base_url != "" ? "remote" : "straitsx" },
      { name = "CARD_API_BASE_URL", value = var.card_api_base_url },
      { name = "PURCHASE_AGENT_MODE", value = "remote" },
      { name = "PURCHASE_AGENT_API_BASE_URL", value = "http://127.0.0.1:4042" },
      # @happy/pay's own configuration. ISSUER=straitsx mints a real card and requires
      # SPEND_PRIVATE_KEY; left at mock the whole rail runs without spending anything.
      { name = "ISSUER", value = var.issuer_mode },
      { name = "CARD_API_BASE", value = var.straitsx_card_api_base },
      { name = "ALLOWED_NETWORK", value = "eip155:${var.funding_chain_id}" },
      { name = "CARDHOLDER_NAME", value = var.cardholder_name },
      # Ephemeral, and that is a real limit: a task restart loses the purchase ledger, so
      # reconciliation cannot recover a payment the dead task had in flight.
      { name = "DATABASE_URL", value = "file:/tmp/happy.db" },
      { name = "FUNDING_MODE", value = var.funding_mode },
      { name = "HAPPY_WALLET_ADDRESS", value = var.happy_wallet_address },
      { name = "CHAIN_ID", value = tostring(var.funding_chain_id) },
      { name = "RPC_URL", value = var.funding_rpc_url },
      { name = "XSGD_ADDRESS", value = var.xsgd_address },
      { name = "XSGD_DECIMALS", value = "6" },
      { name = "FUNDING_NETWORK_NAME", value = var.funding_network_name },
      { name = "FUNDING_EXPLORER_URL", value = var.funding_explorer_url },
      { name = "DEPOSIT_CONFIRMATIONS", value = tostring(var.deposit_confirmations) },
      { name = "PAYMENT_MIN_MINOR", value = tostring(var.payment_min_minor) },
      { name = "PAYMENT_MAX_MINOR", value = tostring(var.payment_max_minor) },
      { name = "PAYMENT_ATTEMPTS_PER_LISTING", value = tostring(var.payment_attempts_per_listing) }
    ]
    secrets = [
      {
        name      = "OPENAI_API_KEY"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:OPENAI_API_KEY::"
      },
      {
        name      = "AGENT_API_TOKEN"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:AGENT_API_TOKEN::"
      },
      {
        name      = "AGENT_CALLBACK_TOKEN"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:AGENT_CALLBACK_TOKEN::"
      },
      {
        name      = "CARD_API_TOKEN"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:CARD_API_TOKEN::"
      },
      {
        name      = "PURCHASE_AGENT_API_TOKEN"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:PURCHASE_AGENT_API_TOKEN::"
      },
      {
        name      = "PURCHASE_CALLBACK_TOKEN"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:PURCHASE_CALLBACK_TOKEN::"
      },
      {
        name      = "WALLET_AUTH_SECRET"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:WALLET_AUTH_SECRET::"
      },
      {
        name      = "SPEND_PRIVATE_KEY"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:SPEND_PRIVATE_KEY::"
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.backend.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "backend"
      }
    }
    healthCheck = {
      command = [
        "CMD-SHELL",
        "node -e \"fetch('http://127.0.0.1:8787/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""
      ]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    },
    /*
     * The Closer, alongside the backend rather than behind its own load balancer.
     *
     * It drives a remote AgentCore browser, so it needs no Chromium of its own and no inbound
     * route: the only client is the backend on loopback, and the only egress is to AWS and the
     * merchant. Its port is deliberately absent from the ALB target group — a public Closer would
     * accept purchase jobs from anyone holding a guessed token.
     */
    {
      name             = "closer"
      image            = var.backend_image
      essential        = false
      command          = ["pnpm", "--filter", "@happy/closer", "service"]
      workingDirectory = "/app"
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "CLOSER_SERVICE_PORT", value = "4042" },
        # Live-view URLs the browser must resolve, so they point at Happy's public origin and
        # arrive back through the backend's /v1/closer proxy. The Closer itself stays unroutable.
        { name = "CLOSER_PUBLIC_BASE_URL", value = "https://${aws_cloudfront_distribution.app.domain_name}/v1/closer" },
        # A real browser in Bedrock AgentCore, using this task's role for credentials.
        { name = "CLOSER_BROWSER", value = "agentcore" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "OPENAI_MODEL", value = var.openai_model },
        { name = "OPENAI_BASE_URL", value = "https://api.openai.com/v1" },
        { name = "CARD_TYPE_DELAY_MS", value = "" }
      ]
      secrets = [
        {
          name      = "PURCHASE_AGENT_API_TOKEN"
          valueFrom = "${aws_secretsmanager_secret.backend.arn}:PURCHASE_AGENT_API_TOKEN::"
        },
        {
          name      = "OPENAI_API_KEY"
          valueFrom = "${aws_secretsmanager_secret.backend.arn}:OPENAI_API_KEY::"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.backend.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "closer"
        }
      }
  }])

  tags = local.common_tags
}

resource "aws_ecs_service" "backend" {
  count = var.deploy_backend ? 1 : 0

  name            = "backend"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Keep the current task serving until its replacement passes both container
  # and ALB health checks. A rollout may briefly run two revisions, but that is
  # preferable to returning 503 while the only task is being replaced.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30
  enable_execute_command             = true
  wait_for_steady_state              = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.backend.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = 8787
  }

  depends_on = [aws_lb_listener.backend]
  tags       = local.common_tags
}
