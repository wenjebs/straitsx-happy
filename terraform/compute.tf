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
      { name = "AGENT_API_BASE_URL", value = var.agent_api_base_url },
      { name = "PAYMENT_API_BASE_URL", value = var.payment_api_base_url },
      { name = "PAYMENT_MIN_MINOR", value = tostring(var.payment_min_minor) },
      { name = "PAYMENT_MAX_MINOR", value = tostring(var.payment_max_minor) },
      { name = "PAYMENT_ATTEMPTS_PER_LISTING", value = tostring(var.payment_attempts_per_listing) }
    ]
    secrets = [
      {
        name      = "AGENT_API_TOKEN"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:AGENT_API_TOKEN::"
      },
      {
        name      = "AGENT_CALLBACK_TOKEN"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:AGENT_CALLBACK_TOKEN::"
      },
      {
        name      = "PAYMENT_API_TOKEN"
        valueFrom = "${aws_secretsmanager_secret.backend.arn}:PAYMENT_API_TOKEN::"
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

  # Event fan-out is process-local today. Avoid two active revisions during a
  # deployment; EventSource reconnects and receives a fresh DynamoDB snapshot.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 30
  enable_execute_command             = true

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
