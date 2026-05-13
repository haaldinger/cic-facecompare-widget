import { Component, OnDestroy, inject, ChangeDetectorRef, NgZone, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AppConfigService, AuthenticationService } from '@alfresco/adf-core';
import { StartProcessCloudService, ProcessCloudService, ProcessListCloudService } from '@alfresco/adf-process-services-cloud';
import { ProcessQueryCloudRequestModel } from '@alfresco/adf-process-services-cloud';
import { HxpUploadService } from '@hxp/workspace-hxp/shared/upload-files/feature-shell';
import { interval, Subscription, firstValueFrom } from 'rxjs';
import { trigger, transition, style, animate } from '@angular/animations';
import { FileModel } from '@hxp/shared-hxp/services';

@Component({
  selector: 'app-face-melter',
  standalone: false,
  templateUrl: './face-melter.component.html',
  styleUrls: ['./face-melter.component.scss'],
  animations: [
    trigger('fadeSlide', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(10px)' }),
        animate('300ms ease-out', style({ opacity: 1, transform: 'translateY(0)' }))
      ])
    ])
  ]
})
export class FaceMelterComponent implements OnDestroy, AfterViewChecked {
  @ViewChild('confettiCanvas') confettiCanvas?: ElementRef<HTMLCanvasElement>;
  private confettiFired = false;
  // Upload & Current Run State
  sourceFile: File | null = null;
  targetFile: File | null = null;
  sourcePreview: string | null = null;
  targetPreview: string | null = null;

  isSourceDragOver = false;
  isTargetDragOver = false;
  isLoading = false;

  processInstanceId: string | null = null;
  processInstance: any = null;
  tasks: any[] = [];
  
  currentRekognitionResult: any = null;
  foundVariableName: string | null = null;
  debugVariables: any = null;
  dataExplorerOpen = false;
  pollingAttempt: number = 0;

  // Ring animation
  readonly ringCircumference = 2 * Math.PI * 52; // r=52
  get ringOffset(): number {
    const pct = this.getSimilarity() / 100;
    return this.ringCircumference * (1 - pct);
  }

  private pollingSub?: Subscription;
  private startTime: number = 0;
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);

  // Tracking Panel State
  elapsedTime: string = '00:00';
  activityLog: { time: string; message: string; type: 'info' | 'success' | 'error' }[] = [];
  pipelineSteps = [
    { id: 'upload', label: 'Upload Files', state: 'pending', detail: '' },
    { id: 'create', label: 'Create Content Nodes', state: 'pending', detail: '' },
    { id: 'trigger', label: 'Trigger Workflow', state: 'pending', detail: '' },
    { id: 'classify', label: 'AWS Rekognition', state: 'pending', detail: '' },
    { id: 'review', label: 'Review Comparison', state: 'pending', detail: '' }
  ];

  // Historical Runs State
  historicalInstances: any[] = [];
  isLoadingHistory = false;
  waitingForUser = false;

  // Injected HXP services
  private readonly appConfigService = inject(AppConfigService);
  private readonly authService = inject(AuthenticationService);
  private readonly startProcessCloudService = inject(StartProcessCloudService);
  private readonly processCloudService = inject(ProcessCloudService);
  private readonly processListCloudService = inject(ProcessListCloudService);
  private readonly uploadService = inject(HxpUploadService);
  private readonly snackBar = inject(MatSnackBar);

  // Use the exact process definition key from Studio
  private readonly processDefinitionKey = 'Process_1767797409502';

  private get appName(): string {
    try {
      const apps = this.appConfigService.get<any[]>('alfresco-deployed-apps');
      return apps?.[0]?.name ?? '';
    } catch {
      return '';
    }
  }

  ngOnInit() {
    this.loadHistory();
  }

  ngOnDestroy() {
    this.stopPolling();
  }

  onDragOver(event: DragEvent, type: 'source' | 'target') {
    event.preventDefault();
    if (type === 'source') this.isSourceDragOver = true;
    else this.isTargetDragOver = true;
  }

  onDragLeave(event: DragEvent, type: 'source' | 'target') {
    if (type === 'source') this.isSourceDragOver = false;
    else this.isTargetDragOver = false;
  }

  onDrop(event: DragEvent, type: 'source' | 'target') {
    event.preventDefault();
    this.onDragLeave(event, type);
    
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    this.processSelectedFiles(files, type);
  }

  onFileSelected(event: any, type: 'source' | 'target') {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    this.processSelectedFiles(files, type);
  }

  private processSelectedFiles(files: FileList, preferredType: 'source' | 'target') {
    // If they selected/dropped two or more images at once
    if (files.length >= 2) {
      if (files[0].type.startsWith('image/')) this.handleFile(files[0], 'source');
      if (files[1].type.startsWith('image/')) this.handleFile(files[1], 'target');
    } 
    // If they only selected one, put it in the box they dropped it on
    else if (files.length === 1 && files[0].type.startsWith('image/')) {
      this.handleFile(files[0], preferredType);
    }
  }

  private handleFile(file: File, type: 'source' | 'target') {
    if (type === 'source') {
      this.sourceFile = file;
    } else {
      this.targetFile = file;
    }
    const reader = new FileReader();
    reader.onload = (e: any) => {
      if (type === 'source') this.sourcePreview = e.target.result;
      else this.targetPreview = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  async submitAndTriggerProcess() {
    if (!this.sourceFile || !this.targetFile) return;

    const currentAppName = this.appName;
    if (!currentAppName) {
      this.snackBar.open('Error: No deployed app configured. Check app.config.json', 'Close', { duration: 5000 });
      return;
    }

    this.isLoading = true;
    this.processInstanceId = null;
    this.currentRekognitionResult = null;
    this.confettiFired = false;
    this.tasks = [];
    this.activityLog = [];
    this.elapsedTime = '00:00';
    this.startTime = Date.now();
    this.waitingForUser = false;
    this.pipelineSteps.forEach(s => { s.state = 'pending'; s.detail = ''; });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const subFolder = `ha-sim-${timestamp}`;

    try {
      // 1. Upload both files
      this.updatePipeline('upload', 'active');
      this.logActivity('info', `Initializing upload session to /${subFolder}`);
      const sourceUpload = await this.uploadFileToHxp(this.sourceFile);
      const targetUpload = await this.uploadFileToHxp(this.targetFile);
      this.updatePipeline('upload', 'completed', `Uploaded 2 files`);
      this.logActivity('success', `Binaries persisted in HXP storage`);

      // 2. Create Document Nodes in Timestamp Folder
      this.updatePipeline('create', 'active');
      this.logActivity('info', `Building document nodes in repository`);
      const sourceDoc = await this.createDocumentNode(sourceUpload, this.sourceFile, subFolder);
      const targetDoc = await this.createDocumentNode(targetUpload, this.targetFile, subFolder);
      this.updatePipeline('create', 'completed', `Created 2 nodes`);
      this.logActivity('success', `Repository nodes synced successfully`);

      // 3. Trigger the process
      this.updatePipeline('trigger', 'active');
      this.logActivity('info', `Dispatching to process engine: ${this.processDefinitionKey}`);
      const payload: any = {
        processDefinitionKey: this.processDefinitionKey,
        name: `Visual Inspector Comparison - ${new Date().toISOString()}`,
        variables: {
          contents: [sourceDoc, targetDoc]
        }
      };

      const instance = await firstValueFrom(
        this.startProcessCloudService.startProcess(currentAppName, payload)
      );
      this.processInstanceId = instance.id;
      this.processInstance = instance;

      this.updatePipeline('trigger', 'completed', `Instance: ${instance.id.split('-')[0]}`);
      this.logActivity('success', `Process triggered. Polling engine state...`);
      this.updatePipeline('classify', 'active');
      
      this.startPolling();
    } catch (error: any) {
      console.error('[Visual Inspector] Trigger Error:', error);
      let errorMsg = 'Unknown error';
      if (error?.response?.body?.message) errorMsg = error.response.body.message;
      else if (error?.error?.message) errorMsg = error.error.message;
      else if (error?.message) errorMsg = error.message;
      else if (typeof error === 'string') errorMsg = error;

      this.logActivity('error', `Pipeline failed: ${errorMsg}`);
      const activeStep = this.pipelineSteps.find(s => s.state === 'active');
      if (activeStep) activeStep.state = 'error';
      
      this.snackBar.open('Error: ' + errorMsg, 'Close', { duration: 5000 });
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Upload a binary file using the HXP UploadApi (same mechanism as the workspace upload button).
   * Returns the upload response data (contains the uploadId needed for document node creation).
   */
  private uploadFileToHxp(file: File): Promise<any> {
    return new Promise((resolve, reject) => {
      const fileModel = new FileModel(file, {
        parentId: '-root-',
        path: '',
        contentType: 'SysFile',
      });

      // Listen for success/error
      const successSub = this.uploadService.fileUploadSuccess.subscribe((event) => {
        if (event.uploadedFile?.fileName === file.name) {
          successSub.unsubscribe();
          errorSub.unsubscribe();
          resolve(event.uploadedFile);
        }
      });

      const errorSub = this.uploadService.fileUploadError.subscribe((event) => {
        if (event.file?.name === file.name) {
          successSub.unsubscribe();
          errorSub.unsubscribe();
          reject(new Error(`Upload failed for ${file.name}: ${event.error?.message || 'Unknown'}`));
        }
      });

      // Queue and start the upload
      this.uploadService.addToQueue(fileModel);
      this.uploadService.uploadFilesInTheQueue();
    });
  }

  /**
   * Create a document node in the HXP content repository from the uploaded binary.
   */
  private async createDocumentNode(uploadedFile: any, originalFile: File, subFolder: string): Promise<any> {
    const ecmHost = this.appConfigService.get<string>('ecmHost') || window.location.origin;
    const token = this.authService.getToken();
    const authHeaders: any = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };
    
    // 1. Try to ensure the unique root folder exists
    try {
      await fetch(`${ecmHost}/api/documents/path/`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ sys_primaryType: 'SysFolder', sys_name: subFolder, sys_title: subFolder })
      });
    } catch (e) { /* ignore */ }

    const docPayload = {
      sys_primaryType: 'SysFile',
      sys_name: originalFile.name,
      sys_title: originalFile.name,
      sysfile_blob: { 
        uploadId: uploadedFile.id,
        filename: originalFile.name,
        mimeType: originalFile.type || 'application/octet-stream',
        length: originalFile.size
      }
    };

    const response = await fetch(`${ecmHost}/api/documents/path/${subFolder}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(docPayload)
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error('[Visual Inspector] Doc creation failed:', response.status, errBody);
      throw new Error(`Failed to create document node: ${response.statusText}`);
    }

    return await response.json();
  }

  private startPolling() {
    this.stopPolling();
    this.updateElapsedTime();
    this.pollingSub = interval(2000).subscribe(() => {
      this.pollProcessStatus();
      this.updateElapsedTime();
    });
  }

  /** Manual status check when waiting for user task completion */
  async checkStatus() {
    this.waitingForUser = false;
    this.logActivity('info', 'Checking task status...');
    await this.pollProcessStatus();
    // If still has pending tasks and process not completed, stay in waiting mode
    const hasPending = this.tasks.some((t: any) => t.status === 'CREATED' || t.status === 'ASSIGNED');
    if (hasPending && this.processInstance?.status !== 'COMPLETED') {
      this.waitingForUser = true;
    } else if (this.processInstance?.status !== 'COMPLETED') {
      // Task was completed but process still running — resume auto-poll
      this.startPolling();
    }
  }

  private stopPolling() {
    if (this.pollingSub) {
      this.pollingSub.unsubscribe();
    }
  }

  private async pollProcessStatus() {
    if (!this.processInstanceId) return;

    try {
      const currentAppName = this.appName;
      
      // 1. Fetch Process Instance
      const instance = await firstValueFrom(
        this.processCloudService.getProcessInstanceById(currentAppName, this.processInstanceId)
      );
      this.processInstance = instance;

      // 2. Fetch Tasks via raw query API (ADF SDK wrappers unreliable for task query)
      const token = this.authService.getToken();
      let newTasks: any[] = [];
      try {
        const taskUrl = `${window.location.origin}/${currentAppName}/query/v1/process-instances/${this.processInstanceId}/tasks?skipCount=0&maxItems=50`;
        const taskRes = await fetch(taskUrl, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (taskRes.ok) {
          const taskJson = await taskRes.json();
          const entries = taskJson?.list?.entries || taskJson?._embedded?.tasks || [];
          newTasks = entries.map((e: any) => e.entry || e);
          console.log('[Visual Inspector] Tasks found:', newTasks.length, newTasks);
        } else {
          console.warn('[Visual Inspector] Task query HTTP', taskRes.status);
        }
      } catch (taskErr) {
        console.warn('[Visual Inspector] Task query error:', taskErr);
      }
      
      // Check for new tasks to log activity
      if (newTasks.length > this.tasks.length) {
        const addedTask = newTasks[newTasks.length - 1];
        this.logActivity('info', `Engine assigned task: ${addedTask.name || addedTask.id}`);
        this.updatePipeline('classify', 'completed');
        this.updatePipeline('review', 'active');
      }
      this.tasks = newTasks;

      // Advance pipeline based on process status
      if (instance?.status === 'SUSPENDED' || (instance?.status === 'RUNNING' && newTasks.length > 0)) {
        this.updatePipeline('classify', 'completed');
        this.updatePipeline('review', 'active');
      }

      // Stop polling once a user task is awaiting action
      const hasPendingTask = newTasks.some((t: any) => t.status === 'CREATED' || t.status === 'ASSIGNED');
      if (hasPendingTask) {
        this.stopPolling();
        this.waitingForUser = true;
        this.logActivity('info', 'Waiting for user task completion. Fetching results...');
        
        // Grab the variable IMMEDIATELY from the Runtime API since the service task is done
        this.fetchFinalResultsFromRuntime(this.processInstanceId);
        return;
      }

      if (this.processInstance?.status === 'COMPLETED') {
        this.stopPolling();
        this.updatePipeline('classify', 'completed');
        this.updatePipeline('review', 'completed');
        this.logActivity('success', `Process pipeline executed successfully.`);
        
        // Try Runtime API first (instant), which falls back to Query API internally
        this.fetchFinalResultsFromRuntime(this.processInstanceId);
      }
    } catch (err) {
      console.error('[Visual Inspector] Error polling process status:', err);
    }
  }

  // --- History Polling ---

  private async loadHistory() {
    const currentAppName = this.appName;
    if (!currentAppName) return;

    this.isLoadingHistory = true;
    try {
      const processReq = new ProcessQueryCloudRequestModel({
        appName: currentAppName,
        processDefinitionKey: this.processDefinitionKey,
        sorting: [{ orderBy: 'startDate', direction: 'DESC' }] as any,
        skipCount: 0,
        maxItems: 5
      });

      const res = await firstValueFrom(this.processListCloudService.getProcessByRequest(processReq as any));
      const instances = res?.list?.entries?.map((e: any) => e.entry) || [];
      
      // Fetch variables for each instance
      const queryHost = window.location.origin;
      const token = this.authService.getToken();

      for (const inst of instances) {
        try {
          const varRes = await fetch(`${queryHost}/${currentAppName}/query/v1/process-instances/${inst.id}/variables?size=100`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          
          if (varRes.ok) {
            const varJson = await varRes.json();
            inst.variables = this.extractVariablesArray(varJson);
            
            // Extract images from 'contents' variable
            const contentsVar = inst.variables.find((v: any) => v.name === 'contents');
            if (contentsVar && Array.isArray(contentsVar.value)) {
              inst.images = contentsVar.value.map((doc: any) => {
                const sysId = doc.sys_id || doc.id;
                return `${queryHost}/api/documents/id/${sysId}/content`;
              });
            }

            // Look for Rekognition/result JSON using flexible matching
            const varNames = inst.variables.map((v: any) => v.name);
            const found = this.findResultVariable(varNames, k => {
              const v = inst.variables.find((vv: any) => vv.name === k);
              return v?.value;
            });
            if (found) {
              inst.rekognitionData = this.parseRekognitionPayload(found.value);
            }
          }
        } catch (e) {
          console.warn(`[Visual Inspector] Failed to load variables for ${inst.id}`, e);
        }
      }

      this.historicalInstances = instances;

      // If we don't have a live process running, but we have history, show the most recent result in the scorecard
      if (!this.processInstanceId && this.historicalInstances.length > 0) {
        const mostRecent = this.historicalInstances.find((i: any) => i.rekognitionData != null);
        if (mostRecent) {
          this.currentRekognitionResult = mostRecent.rekognitionData;
          this.cdr.detectChanges();
        }
      }

    } catch (err) {
      console.error('[Visual Inspector] Error loading history:', err);
    } finally {
      this.isLoadingHistory = false;
    }
  }

  /** Extract variables array from any API response format */
  private extractVariablesArray(json: any): any[] {
    if (!json) return [];
    // HAL format: { _embedded: { variables: [...] } }  OR  { _embedded: [...] }
    if (json._embedded) {
      const embedded = json._embedded;
      if (Array.isArray(embedded)) return embedded;
      // Try common HAL collection keys
      for (const key of ['variables', 'processInstanceVariables', 'taskVariables', 'entries']) {
        if (Array.isArray(embedded[key])) return embedded[key];
      }
      // If _embedded is an object with name/value entries directly
      if (embedded.name && embedded.value !== undefined) return [embedded];
      // Last resort: grab first array-valued property
      for (const key of Object.keys(embedded)) {
        if (Array.isArray(embedded[key])) return embedded[key];
      }
    }
    // Alfresco format: { list: { entries: [{ entry: {...} }] } }
    if (json.list?.entries) {
      return json.list.entries.map((e: any) => e.entry || e);
    }
    // Flat object format (Runtime API): { varName: value, ... }
    if (typeof json === 'object' && !json._links && !json.page) {
      const keys = Object.keys(json);
      if (keys.length > 0 && keys.every(k => !['_embedded', '_links', 'page', 'list'].includes(k))) {
        return keys.map(k => ({ name: k, value: json[k] }));
      }
    }
    return [];
  }

  private parseRekognitionPayload(raw: any): any {
    let data = raw;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { return data; }
    }
    // Lambda wrapper: { statusCode, body: "..." }
    if (data && data.body && typeof data.body === 'string') {
      try { data.body = JSON.parse(data.body); } catch (e) {}
    }
    // Direct Rekognition result
    if (data && !data.body && data.FaceMatches) {
      data = { body: data, statusCode: 200 };
    }
    // Triple-stringified
    if (data?.body?.body && typeof data.body.body === 'string') {
      try { data.body = JSON.parse(data.body.body); } catch (e) {}
    }
    // If it's an array (like batchFlagDocumentReasons), wrap it
    if (Array.isArray(data)) {
      return { _type: 'batch', items: data };
    }
    return data;
  }

  /** Find a rekognition-like variable by name patterns or value shape */
  private findResultVariable(keys: string[], getVal: (k: string) => any): { key: string; value: any } | null {
    this.logActivity('info', `Scanning variables: ${keys.join(', ')}`);
    
    // 1. First, look for obvious name matches
    const patterns = ['rekognition', 'result', 'response', 'output', 'lambda', 'compare', 'facematch', 'similarity'];
    for (const pattern of patterns) {
      const match = keys.find(k => k.toLowerCase().includes(pattern) && k.toLowerCase() !== 'contents');
      if (match) {
        const val = getVal(match);
        if (val) return { key: match, value: val };
      }
    }

    // 2. If no name match, BRUTE FORCE: try to parse every variable and look for Rekognition-like fields
    for (const k of keys) {
      if (k === 'contents' || k === 'initiator') continue;
      let val = getVal(k);
      
      // Attempt to parse if it's a string
      let parsed = val;
      if (typeof val === 'string' && val.trim().startsWith('{')) {
        try { parsed = JSON.parse(val); } catch (e) {}
      }

      // Check for Rekognition signatures
      if (parsed && typeof parsed === 'object') {
        const hasSignatures = parsed.FaceMatches || parsed.Similarity || parsed.Face || 
                            (parsed.body && (typeof parsed.body === 'string' || parsed.body.FaceMatches));
        if (hasSignatures) {
          this.logActivity('success', `Heuristic match: "${k}" looks like Rekognition data.`);
          return { key: k, value: val };
        }
      }
    }

    // 3. Last resort: grab the first variable with any non-trivial object/array value
    for (const k of keys) {
      if (k === 'contents' || k === 'initiator') continue;
      const val = getVal(k);
      if (val && (typeof val === 'object' || (typeof val === 'string' && val.length > 20))) {
        this.logActivity('success', `Fallback match: using "${k}" as result variable.`);
        return { key: k, value: val };
      }
    }
    return null;
  }

  private async fetchFinalResultsFromRuntime(instanceId: string) {
    if (!instanceId) return;
    const currentAppName = this.appName;
    if (!currentAppName) return;
    
    const queryHost = window.location.origin;
    const token = this.authService.getToken();

    try {
      // The Runtime API returns a FLAT object: { "varName": value, ... }
      const varRes = await fetch(`${queryHost}/${currentAppName}/rb/v1/process-instances/${instanceId}/variables`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (varRes.ok) {
        const varJson = await varRes.json();
        console.log('[Visual Inspector] Runtime API raw:', JSON.stringify(varJson).substring(0, 500));

        const variables = this.extractVariablesArray(varJson);
        const varNames = variables.map((v: any) => v.name);
        this.logActivity('info', `Runtime vars: [${varNames.join(', ')}]`);

        this.zone.run(() => { this.debugVariables = variables; this.cdr.detectChanges(); });

        const found = this.findResultVariable(varNames, k => {
          const v = variables.find((vv: any) => vv.name === k);
          return v?.value;
        });
        if (found) {
          this.logActivity('success', `Rendering scorecard from "${found.key}"`);
          const parsed = this.parseRekognitionPayload(found.value);
          this.zone.run(() => {
            this.foundVariableName = found.key;
            this.currentRekognitionResult = parsed;
            this.cdr.detectChanges();
          });
          return;
        }
        this.logActivity('info', 'No result variable found in Runtime response, trying Query API...');
      }
    } catch (e) {
      console.warn('[Visual Inspector] Runtime API error, falling back to Query API...', e);
    }
    
    // Fallback to Query API if Runtime fails
    this.fetchFinalResultsWithRetry(instanceId, 0);
  }

  private async fetchFinalResultsWithRetry(instanceId: string, attempt: number = 0) {
    if (!instanceId) {
      this.logActivity('error', 'fetchFinalResultsWithRetry: instanceId is null!');
      return;
    }

    if (attempt > 120) {
      this.logActivity('error', 'Failed to retrieve final results from the Query API after 3 minutes.');
      return;
    }
    
    const currentAppName = this.appName;
    if (!currentAppName) {
      this.logActivity('error', 'fetchFinalResultsWithRetry: appName is null!');
      return;
    }
    const queryHost = window.location.origin;
    const token = this.authService.getToken();

    if (attempt === 0) {
      this.logActivity('info', `Polling Query API for variables of instance ${instanceId.substring(0, 8)}...`);
    }

    try {
      const url = `${queryHost}/${currentAppName}/query/v1/process-instances/${instanceId}/variables?size=100`;
      const varRes = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (!varRes.ok) {
        this.logActivity('error', `Query API returned HTTP ${varRes.status} on attempt ${attempt}`);
        setTimeout(() => this.fetchFinalResultsWithRetry(instanceId, attempt + 1), 1500);
        return;
      }

      const varJson = await varRes.json();
      console.log(`[Visual Inspector] Query API attempt ${attempt} raw:`, varJson);

      // Extract variables from whatever format the API returns (HAL _embedded, list.entries, or flat)
      const variables = this.extractVariablesArray(varJson);
      let rekData: any = null;

      this.zone.run(() => {
        this.debugVariables = variables;
        this.pollingAttempt = attempt;
        this.cdr.detectChanges();
      });

      if (attempt % 5 === 0) {
        this.logActivity('info', `Attempt ${attempt}: ${variables.length} variables [${variables.map((v: any) => v.name).join(', ')}]`);
      }

      const found = this.findResultVariable(variables.map((v: any) => v.name), k => {
        const v = variables.find((vv: any) => vv.name === k);
        return v?.value;
      });
      if (found) {
        rekData = this.parseRekognitionPayload(found.value);
      }

      if (rekData) {
        this.logActivity('success', `Rekognition result found on attempt ${attempt}! Rendering scorecard...`);
        console.log('[Visual Inspector] Final parsed result:', rekData);
        
        this.zone.run(() => {
          this.currentRekognitionResult = rekData;
          this.cdr.detectChanges();
          this.loadHistory();
        });
        return; // Success!
      }
    } catch (e: any) {
      console.warn('[Visual Inspector] Query API error:', e);
      if (attempt % 5 === 0) {
        this.logActivity('error', `Attempt ${attempt} error: ${e?.message || e}`);
      }
    }

    // If we didn't find the variable, wait 1.5 seconds and try again
    setTimeout(() => {
      this.fetchFinalResultsWithRetry(instanceId, attempt + 1);
    }, 1500);
  }

  // --- UI Helpers ---

  private updatePipeline(id: string, state: string, detail?: string) {
    const step = this.pipelineSteps.find(s => s.id === id);
    if (step) {
      step.state = state;
      if (detail !== undefined) step.detail = detail;
    }
  }

  // --- Result Extractors ---
  
  get isSuccessfulResult(): boolean {
    const data = this.currentRekognitionResult;
    if (!data) return false;
    if (data._type === 'batch') return true;
    return !!(data.body || data.statusCode == 200);
  }

  get isBatchResult(): boolean {
    return this.currentRekognitionResult?._type === 'batch';
  }

  get hasMatch(): boolean {
    if (this.isBatchResult) {
      const items = this.currentRekognitionResult.items || [];
      return items.some((item: any) => 
        item.flagged === true || item.matched === true || item.match === true ||
        (item.similarity && item.similarity >= 80) ||
        (item.confidence && item.confidence >= 80)
      );
    }
    return this.getSimilarity() >= 80;
  }

  getSimilarity(): number {
    const data = this.currentRekognitionResult;
    if (!data) return 0;
    if (data.body?.FaceMatches?.length > 0) {
      return data.body.FaceMatches[0].Similarity || 0;
    }
    if (data._type === 'batch' && data.items?.length > 0) {
      for (const item of data.items) {
        if (item.similarity) return item.similarity;
        if (item.confidence) return item.confidence;
        if (item.score) return item.score;
      }
    }
    return 0;
  }

  getMetric(type: 'Brightness' | 'Sharpness' | 'Confidence'): number {
    const data = this.currentRekognitionResult;
    if (!data?.body) return 0;
    let faceData = null;
    if (data.body.FaceMatches?.length > 0) {
      faceData = data.body.FaceMatches[0].Face;
    } else if (data.body.UnmatchedFaces?.length > 0) {
      faceData = data.body.UnmatchedFaces[0];
    }
    if (!faceData) return 0;
    if (type === 'Confidence') return faceData.Confidence || 0;
    if (faceData.Quality) return faceData.Quality[type] || 0;
    return 0;
  }

  getBatchItems(): any[] {
    if (!this.isBatchResult) return [];
    return this.currentRekognitionResult.items || [];
  }

  /** Get source face bounding box (the face submitted for comparison) */
  getSourceBoundingBox(): any | null {
    const data = this.currentRekognitionResult;
    if (!data?.body?.SourceImageFace?.BoundingBox) return null;
    return data.body.SourceImageFace.BoundingBox;
  }

  /** Get all target face bounding boxes (matched + unmatched) */
  getTargetBoundingBoxes(): { box: any; similarity: number; matched: boolean }[] {
    const data = this.currentRekognitionResult;
    if (!data?.body) return [];
    const boxes: { box: any; similarity: number; matched: boolean }[] = [];

    if (data.body.FaceMatches) {
      for (const fm of data.body.FaceMatches) {
        if (fm.Face?.BoundingBox) {
          boxes.push({ box: fm.Face.BoundingBox, similarity: fm.Similarity || 0, matched: true });
        }
      }
    }
    if (data.body.UnmatchedFaces) {
      for (const uf of data.body.UnmatchedFaces) {
        if (uf.BoundingBox) {
          boxes.push({ box: uf.BoundingBox, similarity: 0, matched: false });
        }
      }
    }
    return boxes;
  }

  /** Convert AWS BoundingBox ratios to CSS percentage styles */
  boxStyle(box: any): { [key: string]: string } {
    if (!box) return {};
    return {
      left: (box.Left * 100) + '%',
      top: (box.Top * 100) + '%',
      width: (box.Width * 100) + '%',
      height: (box.Height * 100) + '%',
    };
  }

  /** Crop position for source image based on bounding box */
  getSourceCropPosition(): string {
    const box = this.getSourceBoundingBox();
    if (!box) return 'center center';
    const cx = (box.Left + box.Width / 2) * 100;
    const cy = (box.Top + box.Height / 2) * 100;
    return `${cx}% ${cy}%`;
  }

  getSourceCropZoom(): string {
    const box = this.getSourceBoundingBox();
    if (!box) return '150%';
    const zoom = Math.min(1 / box.Width, 1 / box.Height) * 70;
    return `${Math.max(zoom, 150)}%`;
  }

  getTargetCropPosition(): string {
    const boxes = this.getTargetBoundingBoxes();
    const matched = boxes.find(b => b.matched);
    if (!matched) return 'center center';
    const cx = (matched.box.Left + matched.box.Width / 2) * 100;
    const cy = (matched.box.Top + matched.box.Height / 2) * 100;
    return `${cx}% ${cy}%`;
  }

  getTargetCropZoom(): string {
    const boxes = this.getTargetBoundingBoxes();
    const matched = boxes.find(b => b.matched);
    if (!matched) return '150%';
    const zoom = Math.min(1 / matched.box.Width, 1 / matched.box.Height) * 70;
    return `${Math.max(zoom, 150)}%`;
  }

  ngAfterViewChecked() {
    if (this.hasMatch && this.confettiCanvas && !this.confettiFired) {
      this.confettiFired = true;
      setTimeout(() => this.fireConfetti(), 600);
    }
  }

  private fireConfetti() {
    const canvas = this.confettiCanvas?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;
    if (parent) {
      canvas.width = parent.offsetWidth;
      canvas.height = parent.offsetHeight;
    }

    const colors = ['#6e33ff', '#8b5cf6', '#22c55e', '#f59e0b', '#ec4899', '#3b82f6'];
    const particles: { x: number; y: number; vx: number; vy: number; size: number; color: string; life: number }[] = [];

    for (let i = 0; i < 80; i++) {
      particles.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 100,
        y: canvas.height * 0.3,
        vx: (Math.random() - 0.5) * 12,
        vy: -Math.random() * 8 - 2,
        size: Math.random() * 6 + 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 1,
      });
    }

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.2;
        p.life -= 0.012;
        if (p.life <= 0) continue;
        alive = true;
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size * 0.6);
      }
      ctx.globalAlpha = 1;
      if (alive) requestAnimationFrame(animate);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    requestAnimationFrame(animate);
  }

  private logActivity(type: 'info' | 'success' | 'error', message: string) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    this.activityLog.unshift({ time, message, type });
  }

  private updateElapsedTime() {
    if (!this.startTime) return;
    const diffMs = Date.now() - this.startTime;
    const seconds = Math.floor((diffMs / 1000) % 60);
    const minutes = Math.floor((diffMs / (1000 * 60)) % 60);
    this.elapsedTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  getTaskLink(task: any): string {
    const host = this.appConfigService.get<string>('ecmHost') || window.location.origin;
    return `${host}/#/tasks/task-details/${task.id}`;
  }

  objectKeys(obj: any): string[] {
    return obj ? Object.keys(obj) : [];
  }

  isSimpleValue(val: any): boolean {
    return val === null || val === undefined || typeof val !== 'object';
  }
}
