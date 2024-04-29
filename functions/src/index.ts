import { initializeApp } from 'firebase-admin/app';
import { onRequest } from 'firebase-functions/v2/https';
import { info } from 'firebase-functions/logger';
import { defineString } from 'firebase-functions/params';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from 'octokit';
import { v2beta3 } from '@google-cloud/tasks';
import * as jwt from 'jsonwebtoken';

type Project = {
  projectName: string;
  workflowID: string;
  installationID: string;
};

const PROJECT_ID = defineString('PROJECT_ID');
const QUEUE_NAME = defineString('QUEUE_NAME');
const APP_ID = defineString('APP_ID');
const PRIVATE_KEY = defineString('PRIVATE_KEY');
const API_KEY = defineString('API_KEY');
const location = 'us-central1';

initializeApp();
import * as admin from 'firebase-admin';

const db = admin.firestore();

export const queueBuild = onRequest(async (req, res) => {
  // Validate the API key
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY.value()) {
    res.status(403).send('Invalid API key');
    return;
  }

  info(req.body);
  const { owner, repo } = req.body;

  const { workflowID, appToken } = await getIDs(owner, repo);

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
  const dispatchWorkflow = workflows.find((workflow: any) =>
    workflow.name.includes('dispatch')
  );

  return dispatchWorkflow.id;
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

async function getCachedIDs(
  owner: string,
  repo: string
): Promise<Project | undefined> {
  const snapshot = await db.collection('ids').get();
  const data = snapshot.docs.map((doc) => {
    return { ...doc.data() };
  });

  const projectName = `${owner}/${repo}`;
  const project = data.find((doc) => doc.projectName === projectName) as
    | Project
    | undefined;

  return project;
}

async function cacheIDs(
  owner: string,
  repo: string,
  workflowID: string,
  installationID: string
) {
  const collection = db.collection('ids');
  const projectName = `${owner}/${repo}`;

  const docRef = await collection.add({
    projectName,
    workflowID,
    installationID,
  });

  info('added to cache: ', docRef);
}

async function getIDs(
  owner: string,
  repo: string
): Promise<{ workflowID: string; appToken: string }> {
  const projectInfo = await getCachedIDs(owner, repo);
  if (projectInfo !== undefined) {
    // load from cached data on Firestore
    const { workflowID, installationID } = projectInfo;

    // create install access token
    const appToken = await createAppInstallationToken(installationID);

    return { workflowID, appToken };
  }
  // get data from Github

  const jwtToken = generateJwt();

  // get installationID
  const installationID = await getInstallationId(owner, repo, jwtToken);

  // create install access token
  const appToken = await createAppInstallationToken(installationID);

  // get workflowID
  const workflowID = await getWorkflowID(owner, repo, appToken);

  // cache data to firestore
  await cacheIDs(owner, repo, workflowID, installationID);
  return { workflowID, appToken };
}
