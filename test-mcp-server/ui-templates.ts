import { createUIResource } from '@mcp-ui/server';

/**
 * Generate resize observer script for dynamic iframe sizing
 */
function getResizeScript() {
  return `
    <script>
      (function() {
        // Function to send size update to parent
        function sendSizeUpdate() {
          const height = document.documentElement.scrollHeight;
          const width = document.documentElement.scrollWidth;

          console.log('[UI Resource] Sending size update:', { height, width });

          window.parent.postMessage({
            type: 'ui-size-change',
            payload: { height, width }
          }, '*');
        }

        // Send initial size on load
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => {
            console.log('[UI Resource] DOM loaded, sending initial size');
            sendSizeUpdate();
          });
        } else {
          console.log('[UI Resource] DOM already loaded, sending initial size');
          sendSizeUpdate();
        }

        // Watch for size changes using ResizeObserver
        if (typeof ResizeObserver !== 'undefined') {
          const resizeObserver = new ResizeObserver((entries) => {
            console.log('[UI Resource] ResizeObserver detected change');
            sendSizeUpdate();
          });
          resizeObserver.observe(document.documentElement);
        }
      })();
    </script>
  `;
}

/**
 * Get counter UI resource
 */
export function getCounterUI(count: number = 0) {
  const html = `
        <div style="padding: 20px; font-family: system-ui;">
          <h2>Interactive Counter</h2>
          <div style="font-size: 48px; margin: 20px 0;">
            Count: ${count}
          </div>
          <div style="display: flex; gap: 10px;">
            <button onclick="window.parent.postMessage({
              type: 'tool',
              payload: {
                toolName: 'counter_action',
                params: { action: 'increment' }
              }
            }, '*')" style="padding: 10px 20px; font-size: 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">
              Increment
            </button>
            <button onclick="window.parent.postMessage({
              type: 'tool',
              payload: {
                toolName: 'counter_action',
                params: { action: 'decrement' }
              }
            }, '*')" style="padding: 10px 20px; font-size: 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">
              Decrement
            </button>
            <button onclick="window.parent.postMessage({
              type: 'tool',
              payload: {
                toolName: 'counter_action',
                params: { action: 'reset' }
              }
            }, '*')" style="padding: 10px 20px; font-size: 16px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">
              Reset
            </button>
          </div>
        </div>
        ${getResizeScript()}
      `;

  return createUIResource({
    uri: 'ui://counter/main',
    content: { type: 'rawHtml', htmlString:html },
    encoding: 'text',
  });
}

/**
 * Get contact form UI resource
 */
export function getFormUI() {
  const html = `
        <div style="padding: 20px; font-family: system-ui; max-width: 400px;">
          <h2>Contact Form</h2>
          <form id="contactForm">
            <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: 500;">Name:</label>
              <input type="text" id="name" required style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
            </div>
            <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: 500;">Email:</label>
              <input type="email" id="email" required style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
            </div>
            <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: 500;">Message:</label>
              <textarea id="message" rows="4" required style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; resize: vertical;"></textarea>
            </div>
            <button type="submit" style="padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; width: 100%;">
              Submit
            </button>
          </form>
          <script>
            document.getElementById('contactForm').addEventListener('submit', (e) => {
              e.preventDefault();
              const formData = {
                name: document.getElementById('name').value,
                email: document.getElementById('email').value,
                message: document.getElementById('message').value
              };
              window.parent.postMessage({
                type: 'tool',
                payload: {
                  toolName: 'form_submit',
                  params: formData
                }
              }, '*');
            });
          </script>
        </div>
        ${getResizeScript()}
      `;

  return createUIResource({
    uri: 'ui://form/contact',
    content: { type: 'rawHtml', htmlString:html },
    encoding: 'text',
  });
}

/**
 * Get form confirmation UI resource
 */
export function getFormConfirmationUI(name: string) {
  const html = `
        <div style="padding: 20px; font-family: system-ui; max-width: 400px;">
          <div style="background: #d4edda; border: 1px solid #c3e6cb; border-radius: 4px; padding: 15px; margin-bottom: 15px;">
            <h2 style="color: #155724; margin: 0 0 10px 0;">✓ Form Submitted!</h2>
            <p style="color: #155724; margin: 0;">Thank you, <strong>${name}</strong>! Your form has been submitted successfully.</p>
          </div>
          <button onclick="window.parent.postMessage({
            type: 'tool',
            payload: {
              toolName: 'show_form',
              params: {}
            }
          }, '*')" style="padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; width: 100%;">
            Submit Another
          </button>
        </div>
        ${getResizeScript()}
      `;

  return createUIResource({
    uri: 'ui://form/confirmation',
    content: { type: 'rawHtml', htmlString:html },
    encoding: 'text',
  });
}
