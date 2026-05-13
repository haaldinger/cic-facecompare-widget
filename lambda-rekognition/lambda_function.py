import urllib.request
import urllib.parse
import json
import os
import boto3

# --------------------------
# Configuration
# --------------------------
AUTH_URL = "https://auth.iam.experience.hyland.com/idp/connect/token"
DOWNLOAD_URL = (
    "https://dev-3841c76e0c964fd786c773e3327d09a2.content.experience.hyland.com"
    "/api/download/{sys_id}/sysfile_blob?inline=true"
)

# Use env vars in production, fallback to your hardcoded secrets for testing
CLIENT_ID = os.environ.get("HXP_CLIENT_ID", "sc-fb1e1ece-a563-45e4-9425-48ef37c24aa8")
CLIENT_SECRET = os.environ.get("HXP_CLIENT_SECRET", "hyx_cs_hwbOCXTt5vAyi6djouuUwbtDHGh1PFa3FA6xPDFq3DMcVS5GcU")
REPOSITORY = os.environ.get("HXP_REPOSITORY", "default")

# Initialize Rekognition Client (uses Lambda's execution role credentials automatically)
rekognition = boto3.client('rekognition')

# --------------------------
# Authentication
# --------------------------
def get_access_token():
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET
    }).encode("utf-8")
    
    req = urllib.request.Request(AUTH_URL, data=data)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    
    with urllib.request.urlopen(req) as response:
        resp_data = json.loads(response.read().decode("utf-8"))
        token = resp_data.get("access_token")
        if not token:
            raise RuntimeError("Failed to retrieve access token")
        return token

# --------------------------
# Download document
# --------------------------
def download_document(sys_id, token):
    url = DOWNLOAD_URL.format(sys_id=sys_id)
    req = urllib.request.Request(url)
    req.add_header("HXCS-REPOSITORY", REPOSITORY)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "*/*")
    
    with urllib.request.urlopen(req) as response:
        return response.read()

# --------------------------
# Lambda handler
# --------------------------
def lambda_handler(event, context):
    try:
        if event is None:
            event = {}
            
        # Parse body (API Gateway usually sends event['body'] as a string)
        if "body" in event and isinstance(event["body"], str):
            body = json.loads(event["body"])
        else:
            body = event
            
        source_id = body.get("sourceNodeId")
        target_id = body.get("targetNodeId")
        
        if not source_id or not target_id:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Missing sourceNodeId or targetNodeId in JSON payload"})
            }
            
        print(f"Authenticating with HXP...")
        token = get_access_token()
        
        print(f"Downloading source image: {source_id}")
        source_bytes = download_document(source_id, token)
        
        print(f"Downloading target image: {target_id}")
        target_bytes = download_document(target_id, token)
        
        print(f"Calling AWS Rekognition CompareFaces...")
        response = rekognition.compare_faces(
            SourceImage={'Bytes': source_bytes},
            TargetImage={'Bytes': target_bytes},
            SimilarityThreshold=70.0  # Adjust as needed
        )
        
        print("Success! Returning results.")
        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json"
            },
            # API Gateway requires body to be a string
            "body": json.dumps(response)
        }
        
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        print(f"HTTP Error: {e.code} - {error_body}")
        return {
            "statusCode": e.code,
            "body": json.dumps({"error": "HXP API Error", "details": error_body})
        }
    except Exception as e:
        print(f"Error processing request: {str(e)}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
