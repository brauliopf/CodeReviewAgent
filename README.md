# AI Review Agent

## Using the App

App Public Page: https://github.com/apps/python-js-code-reviewer-agent

## Develop and Deploy App

This is a GitHub App that reviews pull requests and submits reviews with AI.

The app listens for webhooks from GitHub and processes them with a generative AI agent. For development purposes, it uses a local server with ngrok to create a secure tunnel to the local server.

### Setup local server with NGROK

1. Download NGROK [here](https://download.ngrok.com/). This will be used to create a secure tunnel to your local server.

2. Run NGROK in your terminal with the following command:

```
ngrok http 3000
```

Here you'll see a URL in the format of `https://<random>.ngrok.app`. Anything running on port 3000 will be available at this URL (tunneling). Set up the GitHub App to use this URL for the webhooks.

### Setup GitHub App

1. Create a new [GitHub App here](https://github.com/settings/apps)

- Make sure to paste the NGROK URL + `/api/review` (e.g. `https://4836-204-48-36-234.ngrok-free.app/api/review`) as the "Webhook URL"
- Create a webhook secret, this can be anything and then paste it in the "secret" field when setting up the GitHub app
- Make sure to grant the app the read & write permissions for the following:
  - Pull Requests
  - Repository Contents
  - Issues
  - Commit Statuses
  - Webhooks
- Subscribe to the following events:

  - Pull Request
  - Pull Request Review
  - Pull Request Review Comment
  - Pull Request Comment Thread
  - Commit Comment

- Download your private key - this will be used later on to authenticate your app

- Install your GitHub app to all of your repositories

2. Clone the repo

```
git clone https://github.com/CoderAgent/SecureAgent
cd SecureAgent
```

3. Install dependencies

```
npm install
```

4. Get your Groq API key [here](https://console.groq.com/keys). Through Groq, you'll have free access to the Llama and Gemini models.

5. Create a `.env` file with the following variables:

```
GITHUB_PRIVATE_KEY=<your-private-key>
GITHUB_APP_ID=<your-app-id>
GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
GROQ_API_KEY=<your-groq-api-key>
```

6. Within the `SecureAgent` directory in your IDE, run the code with the following command:

```
npm run start
```

7. Create a pull request on your repository and watch the review agent submit a review!
