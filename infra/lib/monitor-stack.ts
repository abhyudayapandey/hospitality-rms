import {
  Duration,
  Stack,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_route53 as route53,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { OutletOpsConfig } from './config';
import { tag } from './outlet-ops-stack';

export interface MonitorStackProps extends StackProps {
  config: Pick<OutletOpsConfig, 'domainName' | 'alertEmail'>;
}

// The outside check (ADR 170, review H5), in us-east-1 because Route 53 publishes health-check
// metrics there only. Every 30 seconds it asks http://<domain>/health, which answers 200 only
// when the server, Caddy, the app and the database answer and every server job ran in time
// (plain HTTP: Caddy serves /health there and redirects everything else; an HTTPS check costs
// twice as much). Down for a minute: an email.
export class MonitorStack extends Stack {
  constructor(scope: Construct, id: string, props: MonitorStackProps) {
    super(scope, id, props);
    const { config } = props;
    tag(this, 'Project', 'outlet-ops');

    const alerts = new sns.Topic(this, 'Alerts', {
      displayName: 'Hey Senior outside check',
      enforceSSL: true,
    });
    alerts.addSubscription(new subs.EmailSubscription(config.alertEmail));
    tag(alerts, 'CostProfile', 'always-free');
    tag(alerts, 'CostNote', 'SNS email - first 1000 emails a month free');

    const check = new route53.CfnHealthCheck(this, 'AppHealth', {
      healthCheckConfig: {
        type: 'HTTP',
        fullyQualifiedDomainName: config.domainName,
        port: 80,
        resourcePath: '/health',
        requestInterval: 30,
        failureThreshold: 2,
      },
      healthCheckTags: [
        { key: 'Name', value: 'outlet-ops-app' },
        { key: 'CostProfile', value: 'credits' },
        { key: 'CostNote', value: 'Route 53 health check of an AWS endpoint - 0.50 USD per month' },
      ],
    });

    const alarm = new cloudwatch.Alarm(this, 'AppDown', {
      alarmDescription: `Hey Senior: ${config.domainName}/health has not answered OK for 2 minutes`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Route53',
        metricName: 'HealthCheckStatus',
        dimensionsMap: { HealthCheckId: check.attrHealthCheckId },
        period: Duration.minutes(1),
        statistic: 'Minimum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    alarm.addAlarmAction(new cwActions.SnsAction(alerts));
    alarm.addOkAction(new cwActions.SnsAction(alerts));
  }
}
