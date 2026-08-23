#!/usr/bin/env python3
"""
Packages ~/mmpl-app (backend + frontend + the EC2 bootstrap script) into a
gzipped tarball, base64-encodes it, and embeds it inside deploy/cloudshell-setup.sh.

cloudshell-setup.sh is the script Akash runs himself in AWS CloudShell (this
sandbox's own egress proxy blocks *.amazonaws.com directly, so deployment has
to happen through a script he runs, not a live API call from this session).
That script:
  1. Decodes the embedded tarball back out to /tmp/mmpl-app.tar.gz.
  2. Creates an S3 bucket for document storage.
  3. Creates an IAM role + instance profile (S3 + SSM access).
  4. Creates a security group (80/443, plus 22 for debugging).
  5. Launches a t2.micro EC2 instance in ap-south-1 running Amazon Linux 2023.
  6. Allocates + associates an Elastic IP.
  7. Uploads the app bundle to S3, then uses SSM RunCommand (no SSH key needed)
     to have the instance pull the bundle down and run ec2-bootstrap.sh, which
     installs Node, unpacks the app, runs migrations, creates the admin user,
     and wires up systemd + nginx + Let's Encrypt (via a nip.io domain built
     from the Elastic IP, since there's no real domain name yet).
  8. Prints the final HTTPS URL and where the admin password ended up.

Run this from ~/mmpl-app/deploy/:  python3 build_cloudshell_script.py
"""
import base64
import os
import subprocess
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.dirname(HERE)  # ~/mmpl-app
OUTPUT = os.path.join(HERE, "cloudshell-setup.sh")

EXCLUDE_DIR_NAMES = {"node_modules", "data", ".git"}


def should_include(tarinfo):
    parts = tarinfo.name.split("/")
    if any(p in EXCLUDE_DIR_NAMES for p in parts):
        return None
    # storage/ should exist but stay empty in the bundle - drop any test
    # artifacts left over from local smoke testing.
    if "/storage/" in ("/" + tarinfo.name) and not tarinfo.name.endswith("/storage"):
        return None
    return tarinfo


def build_tarball():
    fd, path = tempfile.mkstemp(suffix=".tar.gz")
    os.close(fd)
    with tarfile.open(path, "w:gz") as tf:
        for entry in ("backend", "frontend", "deploy/ec2-bootstrap.sh"):
            full = os.path.join(APP_ROOT, entry)
            arcname = os.path.join("mmpl-app", entry)
            tf.add(full, arcname=arcname, filter=should_include)
    return path


CLOUDSHELL_TEMPLATE = r'''#!/bin/bash
# MMPL live dashboard - AWS CloudShell deployment script.
# Run this INSIDE AWS CloudShell (console.aws.amazon.com -> CloudShell icon),
# after uploading this file: Actions -> Upload file, then:
#   bash cloudshell-setup.sh
#
# What it does: creates an S3 bucket, an IAM role, a security group, launches
# a t2.micro EC2 instance in ap-south-1, gives it an Elastic IP, and deploys
# the MMPL dashboard app onto it with HTTPS via a nip.io domain + Let's
# Encrypt. Takes about 5-8 minutes. Prints the final URL and admin login at
# the end - save that output.
set -euo pipefail

REGION="ap-south-1"
INSTANCE_TYPE="t2.micro"
RAND_SUFFIX=$(aws secretsmanager get-random-password --exclude-punctuation --password-length 8 --require-each-included-type --output text --query RandomPassword 2>/dev/null | tr '[:upper:]' '[:lower:]' || date +%s)
BUCKET_NAME="mmpl-dashboard-${RAND_SUFFIX}"
ROLE_NAME="mmpl-dashboard-ec2-role"
INSTANCE_PROFILE_NAME="mmpl-dashboard-ec2-profile"
SG_NAME="mmpl-dashboard-sg"
TAG_NAME="mmpl-dashboard"

echo "=================================================="
echo " MMPL Dashboard - AWS deployment"
echo " Region: $REGION | Bucket: $BUCKET_NAME"
echo "=================================================="

echo "[1/9] Decoding application bundle..."
base64 -d <<'APP_BUNDLE_B64' > /tmp/mmpl-app.tar.gz
__APP_BUNDLE_BASE64__
APP_BUNDLE_B64
echo "    bundle size: $(du -h /tmp/mmpl-app.tar.gz | cut -f1)"

echo "[2/9] Creating S3 bucket for document storage..."
if aws s3api head-bucket --bucket "$BUCKET_NAME" --region "$REGION" 2>/dev/null; then
  echo "    bucket already exists, reusing."
else
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  aws s3api put-public-access-block --bucket "$BUCKET_NAME" --region "$REGION" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi
aws s3 cp /tmp/mmpl-app.tar.gz "s3://$BUCKET_NAME/deploy/mmpl-app.tar.gz" --region "$REGION"

echo "[3/9] Creating IAM role + instance profile..."
TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY"
  # IAMFullAccess is intentionally broad - kept as-is from the original spec
  # (Akash may later need this role to provision more resources itself).
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/IAMFullAccess
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  sleep 10  # IAM propagation
fi
if ! aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME"
  aws iam add-role-to-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" --role-name "$ROLE_NAME"
  sleep 15  # instance profile propagation
fi

echo "[4/9] Creating security group..."
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
if [ "$SG_ID" == "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group --region "$REGION" --group-name "$SG_NAME" \
    --description "MMPL dashboard - HTTP/HTTPS/SSH" --vpc-id "$VPC_ID" --query 'GroupId' --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --protocol tcp --port 22 --cidr 0.0.0.0/0
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0
fi

echo "[5/9] Looking up latest Amazon Linux 2023 AMI..."
AMI_ID=$(aws ssm get-parameter --region "$REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)
echo "    AMI: $AMI_ID"

echo "[6/9] Launching EC2 instance ($INSTANCE_TYPE)..."
EXISTING_INSTANCE=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=$TAG_NAME" "Name=instance-state-name,Values=pending,running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")
if [ "$EXISTING_INSTANCE" != "None" ] && [ -n "$EXISTING_INSTANCE" ]; then
  INSTANCE_ID="$EXISTING_INSTANCE"
  echo "    reusing existing instance $INSTANCE_ID"
else
  INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --security-group-ids "$SG_ID" \
    --iam-instance-profile Name="$INSTANCE_PROFILE_NAME" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG_NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
fi
echo "    instance: $INSTANCE_ID"
echo "    waiting for it to enter 'running' state..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

echo "[7/9] Allocating + associating Elastic IP..."
EXISTING_EIP=$(aws ec2 describe-addresses --region "$REGION" \
  --filters "Name=tag:Name,Values=$TAG_NAME" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "None")
if [ "$EXISTING_EIP" != "None" ] && [ -n "$EXISTING_EIP" ]; then
  ALLOC_ID="$EXISTING_EIP"
else
  ALLOC_ID=$(aws ec2 allocate-address --region "$REGION" --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$TAG_NAME}]" \
    --query 'AllocationId' --output text)
fi
aws ec2 associate-address --region "$REGION" --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null
PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC_ID" --query 'Addresses[0].PublicIp' --output text)
DOMAIN="$(echo "$PUBLIC_IP" | tr '.' '-').nip.io"
echo "    public IP: $PUBLIC_IP"
echo "    domain: $DOMAIN"

echo "[8/9] Waiting for SSM agent to come online (can take ~1-2 min after boot)..."
for i in $(seq 1 30); do
  STATUS=$(aws ssm describe-instance-information --region "$REGION" \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo "None")
  if [ "$STATUS" == "Online" ]; then
    echo "    SSM agent online."
    break
  fi
  echo "    ...still waiting ($i/30)"
  sleep 10
done

echo "[9/9] Deploying application via SSM RunCommand..."
REMOTE_SCRIPT="mkdir -p /opt && aws s3 cp s3://$BUCKET_NAME/deploy/mmpl-app.tar.gz /opt/mmpl-app.tar.gz --region $REGION && cd /opt && tar -xzf mmpl-app.tar.gz -C /opt --strip-components=0 && bash /opt/mmpl-app/deploy/ec2-bootstrap.sh $DOMAIN $BUCKET_NAME"
CMD_ID=$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "Deploy MMPL dashboard" \
  --parameters "commands=[\"$REMOTE_SCRIPT\"]" \
  --timeout-seconds 900 \
  --query 'Command.CommandId' --output text)
echo "    SSM command: $CMD_ID (this step can take 3-5 minutes - installing Node, npm deps, requesting a TLS cert)"

for i in $(seq 1 60); do
  CMD_STATUS=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query 'Status' --output text 2>/dev/null || echo "Pending")
  if [ "$CMD_STATUS" == "Success" ] || [ "$CMD_STATUS" == "Failed" ]; then
    break
  fi
  echo "    ...deploy status: $CMD_STATUS ($i/60)"
  sleep 10
done

echo ""
echo "=================================================="
echo " Deployment command status: $CMD_STATUS"
echo "=================================================="
if [ "$CMD_STATUS" != "Success" ]; then
  echo "Deployment script did not finish successfully. Full output:"
  aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query '{stdout:StandardOutputContent,stderr:StandardErrorContent}' --output text
  echo ""
  echo "You can re-run just the deploy step by re-running this script - the S3"
  echo "bucket, IAM role, security group, instance, and Elastic IP are all reused"
  echo "if they already exist."
  exit 1
fi

echo "Application output:"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text

echo ""
echo "=================================================="
echo " DONE"
echo "=================================================="
echo " URL:      https://$DOMAIN"
echo " (falls back to http://$DOMAIN if the TLS certificate request above failed -"
echo "  retry certbot on the instance once nip.io/DNS resolution is confirmed)"
echo ""
echo " Only the ADMIN account is auto-created (see the password printed above,"
echo " and saved on the instance at /root/mmpl-admin-password.txt)."
echo ""
echo " Next steps, from your own machine or CloudShell using SSM:"
echo "   aws ssm start-session --region $REGION --target $INSTANCE_ID"
echo "   cd /opt/mmpl-app/backend"
echo "   node scripts/create-user.js mmpl_client <password> client"
echo "   node scripts/create-user.js <teammate> <password> team '{\"tracking\":true}'"
echo ""
echo " No certificate or document is visible to the client account until you"
echo " explicitly mark it client_visible from the dashboard (Docs modal /"
echo " All Certificates checkboxes)."
echo ""
echo " Fully-automated client drafting (client submits an NIT and gets a draft"
echo " back with no review step) is OFF by default - see the 'GEMINI_API_KEY'"
echo " instructions in the application output above to turn it on. Until then,"
echo " every client request queues for you to draft and deliver by hand."
echo "=================================================="
'''


def main():
    tar_path = build_tarball()
    with open(tar_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    os.unlink(tar_path)

    # Wrap at 100 chars/line purely for readability in an editor; base64 -d
    # doesn't care about line breaks.
    wrapped = "\n".join(b64[i:i + 100] for i in range(0, len(b64), 100))

    script = CLOUDSHELL_TEMPLATE.replace("__APP_BUNDLE_BASE64__", wrapped)
    with open(OUTPUT, "w") as f:
        f.write(script)
    os.chmod(OUTPUT, 0o755)
    print(f"Wrote {OUTPUT} ({os.path.getsize(OUTPUT) / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
