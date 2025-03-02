/**
 * Database Backup Client
 * Handles database backup API requests with progress monitoring and improved error handling
 */

class DatabaseBackupClient {
  constructor(options = {}) {
    this.apiEndpoint = options.apiEndpoint || '/api/backup';
    this.timeout = options.timeout || 20 * 60 * 1000; // 20 minutes default timeout
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.debug = options.debug || false;
  }

  /**
   * Start a database backup with progress monitoring
   * @param {Object} backupData - The backup request data
   * @returns {Promise} A promise that resolves with the backup result
   */
  async startBackup(backupData) {
    // Default to streaming mode if supported by the browser
    const supportsEventSource = typeof EventSource !== 'undefined';
    
    if (supportsEventSource) {
      return this._startStreamingBackup(backupData);
    } else {
      return this._startStandardBackup(backupData);
    }
  }

  /**
   * Start a streaming backup with progress updates via EventSource
   * @private
   * @param {Object} backupData - The backup request data
   * @returns {Promise} A promise that resolves with the backup result
   */
  _startStreamingBackup(backupData) {
    return new Promise((resolve, reject) => {
      // Add streaming parameter to URL
      const url = new URL(this.apiEndpoint, window.location.origin);
      url.searchParams.append('stream', 'true');
      
      // Set timeout for the entire operation
      const timeoutId = setTimeout(() => {
        if (eventSource) {
          eventSource.close();
        }
        reject(new Error('Backup operation timed out after ' + (this.timeout / 60000) + ' minutes'));
      }, this.timeout);
      
      try {
        // Make the request with JSON data in POST body
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
          },
          body: JSON.stringify(backupData),
          credentials: 'same-origin'
        }).then(response => {
          if (!response.ok) {
            clearTimeout(timeoutId);
            throw new Error(`Server error: ${response.status} ${response.statusText}`);
          }
          
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          
          const readChunk = () => {
            reader.read().then(({ done, value }) => {
              if (done) {
                clearTimeout(timeoutId);
                // Handle any remaining data in buffer
                const lastEvent = this._parseEvent(buffer);
                if (lastEvent && lastEvent.event === 'complete') {
                  try {
                    const result = JSON.parse(lastEvent.data);
                    this.onComplete(result);
                    resolve(result);
                  } catch (e) {
                    reject(new Error('Failed to parse completion data'));
                  }
                }
                return;
              }
              
              // Process incoming chunk
              buffer += decoder.decode(value, { stream: true });
              
              // Process any complete events in the buffer
              const events = buffer.split('\\n\\n');
              buffer = events.pop() || ''; // Keep the last incomplete chunk in buffer
              
              for (const eventText of events) {
                if (!eventText.trim()) continue;
                
                const parsedEvent = this._parseEvent(eventText);
                if (!parsedEvent) continue;
                
                if (parsedEvent.event === 'progress') {
                  try {
                    const progress = JSON.parse(parsedEvent.data);
                    this.onProgress(progress);
                  } catch (e) {
                    if (this.debug) console.error('Failed to parse progress data', e);
                  }
                } else if (parsedEvent.event === 'complete') {
                  try {
                    const result = JSON.parse(parsedEvent.data);
                    clearTimeout(timeoutId);
                    this.onComplete(result);
                    resolve(result);
                    return;
                  } catch (e) {
                    if (this.debug) console.error('Failed to parse completion data', e);
                  }
                } else if (parsedEvent.event === 'error') {
                  try {
                    const error = JSON.parse(parsedEvent.data);
                    clearTimeout(timeoutId);
                    this.onError(error);
                    reject(new Error(error.message || 'Backup failed'));
                    return;
                  } catch (e) {
                    if (this.debug) console.error('Failed to parse error data', e);
                  }
                }
              }
              
              // Continue reading
              readChunk();
            }).catch(error => {
              clearTimeout(timeoutId);
              this.onError({ message: error.message });
              reject(error);
            });
          };
          
          readChunk();
        }).catch(error => {
          clearTimeout(timeoutId);
          this.onError({ message: error.message });
          reject(error);
        });
      } catch (error) {
        clearTimeout(timeoutId);
        this.onError({ message: error.message });
        reject(error);
      }
    });
  }

  /**
   * Parse SSE event text into event object
   * @private
   * @param {string} eventText - The raw event text
   * @returns {Object|null} The parsed event or null if invalid
   */
  _parseEvent(eventText) {
    const lines = eventText.split('\\n');
    const event = {};
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      
      const field = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();
      
      if (field === 'event') {
        event.event = value;
      } else if (field === 'data') {
        event.data = value;
      }
    }
    
    if (!event.event || !event.data) return null;
    return event;
  }

  /**
   * Start a standard backup without streaming (fallback)
   * @private
   * @param {Object} backupData - The backup request data
   * @returns {Promise} A promise that resolves with the backup result
   */
  _startStandardBackup(backupData) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const { signal } = controller;
      
      // Set timeout for the entire operation
      const timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error('Backup operation timed out after ' + (this.timeout / 60000) + ' minutes'));
      }, this.timeout);
      
      // Make the request
      fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(backupData),
        credentials: 'same-origin',
        signal
      })
      .then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) {
          throw new Error(`Server error: ${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then(data => {
        if (data.success) {
          this.onComplete(data.data);
          resolve(data.data);
        } else {
          const error = new Error(data.message || 'Backup failed');
          this.onError({ message: error.message });
          reject(error);
        }
      })
      .catch(error => {
        clearTimeout(timeoutId);
        this.onError({ message: error.message });
        reject(error);
      });
    });
  }
}

// Example usage:
/*
const backupClient = new DatabaseBackupClient({
  onProgress: (progress) => {
    console.log(`Backup progress: ${progress.percent}% - ${progress.message}`);
    // Update UI with progress
    document.getElementById('progress-bar').style.width = progress.percent + '%';
    document.getElementById('progress-text').textContent = progress.message;
  },
  onComplete: (result) => {
    console.log('Backup completed:', result);
    // Show success message
    document.getElementById('success-message').textContent = 
      `Backup completed successfully. Download: ${result.url}`;
  },
  onError: (error) => {
    console.error('Backup error:', error);
    // Show error message
    document.getElementById('error-message').textContent = 
      `Backup failed: ${error.message}`;
  },
  debug: true
});

// Start a backup
backupClient.startBackup({
  connectionUrl: 'postgres://user:password@localhost:5432/mydb',
  databaseType: 'postgres',
  storage: 'aws',
  name: 'my-backup'
}).catch(error => {
  console.error('Fatal error:', error);
});
*/
