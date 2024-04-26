import { initializeApp } from 'firebase-admin/app';
import { onRequest } from 'firebase-functions/v2/https';
import { info } from 'firebase-functions/logger';
import { defineString } from 'firebase-functions/params';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from 'octokit';
import * as jwt from 'jsonwebtoken';

const PROJECT_ID = defineString('PROJECT_ID');
const QUEUE_NAME = defineString('QUEUE_NAME');
// const JWT = defineString('JWT');
const APP_ID = defineString('APP_ID');
const PRIVATE_KEY = defineString('PRIVATE_KEY');
const location = 'us-central1';

initializeApp();

// perhaps think about storing installation IDs and workflowIDs

export const queueBuild = onRequest(async (req, res) => {
  info(req.body);
  const { owner, repo } = req.body;

  const jwtToken = generateJwt();

  // get installationID
  const installationId = await getInstallationId(owner, repo, jwtToken);

  // create install access token
  const appToken = await createAppInstallationToken(installationId);

  // get workflowID
  const workflowID = await getWorkflowID(owner, repo, appToken);

  const currentDate = new Date();
  const thisTimestamp = Math.floor(currentDate.getTime() / 1000);

  // run in 5 minutes
  const toRunTimestamp = thisTimestamp + 5 * 60;

  info('about build request', { workflowID, appToken });

  await createBuildTask(toRunTimestamp, appToken, workflowID, owner, repo)
    .then(() => {
      res.send('success');
    })
    .catch((error: any) => {
      res.send(error);
    });
});

async function createBuildTask(
  toRunTimestamp: number,
  appToken: string,
  workflowID: string,
  owner: string,
  repo: string
) {
  // have to import here because it breaks cloud functions otherwise
  const { v2beta3 } = await import('@google-cloud/tasks');
  const tasksClient = new v2beta3.CloudTasksClient();
  const parent = tasksClient.queuePath(
    PROJECT_ID.value(),
    location,
    QUEUE_NAME.value()
  );

  const [tasklist] = await tasksClient.listTasks({ parent });

  // check to see if any tasks in queue already target this URL
  const tasksWithSameURL = tasklist.filter((task) =>
    task.httpRequest?.url?.includes(`${owner}/${repo}`)
  );
  if (tasksWithSameURL.length > 0) {
    info('task debounced');
    console.log(tasksWithSameURL[0].httpRequest?.url);

    // clear to debounce the task
    for (const task of tasksWithSameURL) {
      // shitty code to catch error when task gets deleted more than once
      tasksClient.deleteTask(task).catch((err) => info('error deleting', err));
    }
  }

  const body = {
    ref: 'main',
    inputs: {},
  };

  const task = {
    scheduleTime: {
      seconds: toRunTimestamp,
    },
    httpRequest: {
      httpMethod: 'POST' as const,
      url: `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowID}/dispatches`,
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
    },
  };

  const [response] = await tasksClient.createTask({ parent, task });

  info('task added');
  return response;
}

async function createAppInstallationToken(installationId: string) {
  const auth = createAppAuth({
    appId: APP_ID.value(),
    privateKey: PRIVATE_KEY.value(),
  });

  // Retrieve installation access token
  const installationAuthentication = await auth({
    type: 'installation',
    installationId: installationId,
  });

  return installationAuthentication.token;
}

async function getInstallationId(
  owner: string,
  repo: string,
  jwtToken: string
) {
  const octokit = new Octokit({
    auth: jwtToken,
  });

  const res = await octokit.request(
    `GET /repos/${owner}/${repo}/installation`,
    {
      owner: 'EthanWakeford',
      repo: 'personal-homepage',
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  return res.data.id;
}

async function getWorkflowID(owner: string, repo: string, appToken: string) {
  const octokit = new Octokit({
    auth: appToken,
  });

  const response = await octokit.request(
    `GET /repos/${owner}/${repo}/actions/workflows`,
    {
      owner: 'OWNER',
      repo: 'REPO',
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  const workflows = response.data.workflows;
  const dispatchWorkflow = workflows.filter((workflow: any) =>
    workflow.name.includes('dispatch')
  );

  // should only ever be one????
  return dispatchWorkflow[0].id;
}

function generateJwt() {
  // Generate JWT
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now, // Issued at time
    exp: now + 60, // JWT expiration time (1 minute from issued time)
    iss: '885771', // GitHub App's ID
  };

  const token = jwt.sign(payload, PRIVATE_KEY.value(), { algorithm: 'RS256' });

  return token;
}
