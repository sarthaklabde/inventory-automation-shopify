const express = require('express');
const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const BATCH_SIZE = 10; // Number of products to process in parallel
const CACHE_TTL = 3600000; // Cache time-to-live (1 hour)

// Database connection
let db;

// Optimized cache manager
const cacheManager = {
    cache: new Map(),
    
    set(productId, status, inventory) {
        this.cache.set(productId, {
            status,
            inventory,
            timestamp: Date.now()
        });
    },
    
    get(productId) {
        return this.cache.get(productId);
    },
    
    shouldUpdate(productId, status, inventory) {
        const cached = this.cache.get(productId);
        if (!cached) return true;
        
        const isExpired = (Date.now() - cached.timestamp) > CACHE_TTL;
        return isExpired || 
               cached.status !== status || 
               cached.inventory !== inventory;
    },
    
    clear() {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.timestamp > CACHE_TTL) {
                this.cache.delete(key);
            }
        }
    }
};

// Initialize database with optimized indices
async function initializeDatabase() {
    db = await open({
        filename: 'shopify_automation.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            message TEXT,
            type TEXT
        );
        
        CREATE TABLE IF NOT EXISTS product_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT,
            handle TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            from_status TEXT,
            to_status TEXT
        );
        
        CREATE INDEX IF NOT EXISTS idx_product_changes_timestamp 
        ON product_changes(timestamp);
        
        CREATE INDEX IF NOT EXISTS idx_logs_timestamp 
        ON logs(timestamp);
    `);
}

// Optimized batch logging
async function addLogs(messages) {
    const stmt = await db.prepare(
        'INSERT INTO logs (message, type, timestamp) VALUES (?, ?, DATETIME("now"))'
    );
    
    await db.run('BEGIN TRANSACTION');
    try {
        for (const msg of messages) {
            await stmt.run([msg.message, msg.type]);
        }
        await db.run('COMMIT');
    } catch (error) {
        await db.run('ROLLBACK');
        throw error;
    } finally {
        await stmt.finalize();
    }
}
function formatDateForSQLite(date) {
    return date.toISOString().replace('T', ' ').replace('Z', '');
}

// Helper function to convert SQLite timestamp to ISO string with timezone
function convertSQLiteTimestamp(timestamp) {
    // If timestamp is already in ISO format, return as is
    if (timestamp.includes('T') && timestamp.includes('Z')) {
        return timestamp;
    }
    // Convert SQLite timestamp to ISO format
    return new Date(timestamp + 'Z').toISOString();
}

// Optimized product change tracking
async function trackProductChanges(changes) {
    console.log('Changes being tracked:', JSON.stringify(changes, null, 2));
    
    const stmt = await db.prepare(`
        INSERT INTO product_changes 
        (product_id, handle, from_status, to_status, timestamp) 
        VALUES (?, ?, ?, ?, DATETIME('now'))
    `);
    
    await db.run('BEGIN TRANSACTION');
    try {
        for (const change of changes) {
            console.log('Inserting change:', change);
            await stmt.run([
                change.productId,
                change.handle,
                change.fromStatus || 'UNKNOWN',
                change.toStatus || 'UNKNOWN'
            ]);
        }
        await db.run('COMMIT');
    } catch (error) {
        console.error('Error tracking changes:', error);
        await db.run('ROLLBACK');
        throw error;
    } finally {
        await stmt.finalize();
    }
}

// Initialize Shopify client with retry mechanism
const shopifyClient = axios.create({
    baseURL: `https://${process.env.SHOP_NAME}/admin/api/2024-01/graphql.json`,
    headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.ACCESS_TOKEN
    }
});

// Optimized fetch products with cursor-based pagination
async function fetchProducts(status, limit = 250) {
    const products = [];
    let hasNextPage = true;
    let cursor = null;
    let retryCount = 0;
    const MAX_RETRIES = 5;

    while (hasNextPage) {
        try {
            const query = `
                query($limit: Int!, $cursor: String) {
                    products(first: $limit, after: $cursor, query: "status:${status}") {
                        edges {
                            node {
                                id
                                handle
                                title
                                status
                                metafield(namespace: "custom", key: "automation") {
                                    value
                                }
                                variants(first: 25) {
                                    edges {
                                        node {
                                            id
                                            inventoryQuantity
                                            sku
                                        }
                                    }
                                }
                            }
                            cursor
                        }
                        pageInfo {
                            hasNextPage
                        }
                    }
                }
            `;

            const response = await shopifyClient.post('', {
                query,
                variables: { limit, cursor }
            });

            console.log('API Response:', JSON.stringify(response.data, null, 2));

            // Check for GraphQL errors
            if (response.data.errors) {
                throw new Error(`GraphQL Errors: ${JSON.stringify(response.data.errors)}`);
            }

            const productsData = response.data?.data?.products;
            if (!productsData || !productsData.edges) {
                throw new Error(`Invalid response structure: ${JSON.stringify(response.data)}`);
            }

            const productEdges = productsData.edges;
            
            // Filter products based on automation metafield
            const filteredProducts = productEdges
                .map(edge => edge.node)
                .filter(product => {
                    // Only exclude products where automation is explicitly set to false
                    const automationValue = product.metafield?.value;
                    return automationValue !== 'false';
                });
            
            console.log(`Filtered products: ${filteredProducts.length} of ${productEdges.length}`);
            products.push(...filteredProducts);

            hasNextPage = productsData.pageInfo.hasNextPage;
            cursor = productEdges[productEdges.length - 1]?.cursor;
            
            await new Promise(resolve => setTimeout(resolve, 500));
            retryCount = 0;
        } catch (error) {
            console.error('Error fetching products:', error);
            retryCount++;
            if (retryCount >= MAX_RETRIES) {
                throw new Error(`Failed to fetch products after ${MAX_RETRIES} attempts: ${error.message}`);
            }
            const delay = Math.min(1000 * Math.pow(2, retryCount) + Math.random() * 1000, 30000);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    return products;
}


async function updateProduct(productId, status) {
  const mutation = `
      mutation updateProduct($input: ProductInput!) {
          productUpdate(input: $input) {
              product {
                  id
                  status
              }
              userErrors {
                  field
                  message
              }
          }
      }
  `;

  let retryCount = 0;
  const MAX_RETRIES = 3;

  while (retryCount < MAX_RETRIES) {
      try {
          const response = await shopifyClient.post('', {
              query: mutation,
              variables: {
                  input: {
                      id: productId,
                      status: status
                  }
              }
          });

          if (response.data.errors) {
              throw new Error(response.data.errors[0].message);
          }

          const { userErrors } = response.data.data.productUpdate;
          if (userErrors && userErrors.length > 0) {
              throw new Error(userErrors[0].message);
          }

          return response.data.data.productUpdate.product;

      } catch (error) {
          retryCount++;
          if (retryCount === MAX_RETRIES) {
              throw new Error(`Failed to update product after ${MAX_RETRIES} attempts: ${error.message}`);
          }
          // Exponential backoff
          await new Promise(resolve => 
              setTimeout(resolve, Math.pow(2, retryCount) * 1000)
          );
      }
  }
}
function getTotalInventory(product) {
    if (!product.variants?.edges) {
        return 0;
    }
    
    return product.variants.edges.reduce((total, edge) => {
        const quantity = edge.node?.inventoryQuantity || 0;
        return total + quantity;
    }, 0);
}
// Process products in batches
async function processProductBatch(products, targetStatus) {
    const changes = [];
    const logs = [];
    
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
        const batch = products.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async product => {
            try {
                console.log('Processing product:', {
                    id: product.id,
                    handle: product.handle,
                    status: product.status,
                    automationEnabled: product.metafield?.value !== 'false'
                });

                // Skip processing if automation is explicitly disabled
                if (product.metafield?.value === 'false') {
                    console.log(`Skipping product ${product.handle} - automation disabled`);
                    return;
                }

                if (!product.variants?.edges) {
                    throw new Error('Invalid product structure: missing variants data');
                }

                const inventory = getTotalInventory(product);
                const shouldUpdate = cacheManager.shouldUpdate(
                    product.id, 
                    product.status,
                    inventory
                );

                if (shouldUpdate) {
                    const shouldChangeStatus = 
                        (targetStatus === 'ACTIVE' && inventory > 0) ||
                        (targetStatus === 'DRAFT' && inventory === 0);

                    if (shouldChangeStatus) {
                        const currentStatus = product.status;
                        const updatedProduct = await updateProduct(product.id, targetStatus);
                        
                        changes.push({
                            productId: product.id,
                            handle: product.handle,
                            fromStatus: currentStatus,
                            toStatus: targetStatus
                        });

                        logs.push({
                            message: `Status change for ${product.handle}: ${currentStatus} → ${targetStatus}`,
                            type: 'info'
                        });
                    }
                    
                    cacheManager.set(product.id, targetStatus, inventory);
                }
            } catch (error) {
                console.error(`Error processing product ${product.handle}:`, error);
                logs.push({
                    message: `Error processing product ${product.handle}: ${error.message}`,
                    type: 'error'
                });
            }
        }));

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (changes.length > 0) {
        await trackProductChanges(changes);
    }
    if (logs.length > 0) {
        await addLogs(logs);
    }

    return { changes: changes.length, processed: products.length };
}

// Main product check functions
async function checkDraftProducts() {
    const draftProducts = await fetchProducts('DRAFT');
    return processProductBatch(draftProducts, 'ACTIVE');
}

async function checkActiveProducts() {
    const activeProducts = await fetchProducts('ACTIVE');
    return processProductBatch(activeProducts, 'DRAFT');
}

// Express routes
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
    try {
        // Use UTC time for consistency
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        const [logs, recentChanges] = await Promise.all([
            db.all(`
                SELECT 
                    id,
                    DATETIME(timestamp) as timestamp,
                    message,
                    type 
                FROM logs 
                ORDER BY timestamp DESC 
                LIMIT 1000
            `),
            db.all(`
                SELECT 
                    id,
                    DATETIME(timestamp) as timestamp,
                    product_id,
                    handle,
                    from_status,
                    to_status
                FROM product_changes 
                WHERE timestamp > DATETIME(?)
                ORDER BY timestamp DESC
            `, [formatDateForSQLite(twentyFourHoursAgo)])
        ]);

        // Convert timestamps to ISO format
        const formattedLogs = logs.map(log => ({
            ...log,
            timestamp: convertSQLiteTimestamp(log.timestamp)
        }));

        const formattedChanges = recentChanges.map(change => ({
            ...change,
            timestamp: convertSQLiteTimestamp(change.timestamp)
        }));

        console.log('Recent changes being sent:', JSON.stringify(formattedChanges, null, 2));

        res.json({ 
            logs: formattedLogs, 
            recentChanges: formattedChanges 
        });
    } catch (error) {
        console.error('Error in /api/data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Main automation loop
async function runAutomation() {
    while (true) {
        try {
            const startTime = Date.now();
            
            const [draftResults, activeResults] = await Promise.all([
                checkDraftProducts(),
                checkActiveProducts()
            ]);

            const totalProcessed = draftResults.processed + activeResults.processed;
            const totalChanges = draftResults.changes + activeResults.changes;
            
            await addLogs([{
                message: `Completed cycle: Processed ${totalProcessed} products, made ${totalChanges} changes`,
                type: 'info'
            }]);

            // Clear expired cache entries
            cacheManager.clear();
            
            // Wait at least 5 minutes between cycles
            const executionTime = Date.now() - startTime;
            const delay = Math.max(300000 - executionTime, 0);
            await new Promise(resolve => setTimeout(resolve, delay));
            
        } catch (error) {
            await addLogs([{
                message: `Critical error in automation: ${error.message}`,
                type: 'error'
            }]);
            await new Promise(resolve => setTimeout(resolve, 60000));
        }
    }
}

// Start application
async function startApp() {
    try {
        await initializeDatabase();
        app.listen(port, () => {
            addLogs([{
                message: `Monitor UI server started on port ${port}`,
                type: 'info'
            }]);
            runAutomation();
        });
    } catch (error) {
        console.error('Fatal error starting application:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    await addLogs([{
        message: 'Received SIGTERM signal. Shutting down gracefully...',
        type: 'info'
    }]);
    process.exit(0);
});

process.on('SIGINT', async () => {
    await addLogs([{
        message: 'Received SIGINT signal. Shutting down gracefully...',
        type: 'info'
    }]);
    process.exit(0);
});

startApp();