require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// 1. Conexión a Base de Datos (Usa Railway online o localhost en tu Mac)
const db = mysql.createConnection({
    host: process.env.MYSQLHOST || 'localhost',
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD, 
    database: process.env.MYSQLDATABASE || 'Clientes Andreina',
    port: process.env.MYSQLPORT || 3306
});

db.connect((err) => {
    if (err) console.error('Error DB:', err);
    else console.log('¡Conectado a MySQL!');
});

// 2. Middleware de autenticación mejorado
app.use((req, res, next) => {
    // Si el navegador pide un archivo (como .css, .js, .png, etc.), deja pasar
    if (req.path !== '/' && req.path.indexOf('.') !== -1) {
        return next();
    }

    const auth = req.headers.authorization;
    if (auth === `Basic ${Buffer.from(process.env.SISTEMA_USER + ':' + process.env.SISTEMA_PASS).toString('base64')}`) {
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic');
        res.status(401).send('Acceso denegado');
    }
});


// 3. Servir archivos estáticos (Ahora sí los encontrará)
app.use(express.static('public'));

app.listen(3000, () => console.log('Servidor corriendo en http://localhost:3000'));

// ==========================================================================
// RUTA 1: Obtener clientes en ALERTA (No han comprado en el mes actual o son nuevos)
// ==========================================================================
app.get('/api/clientes/alertas', (req, res) => {
    const query = `
        SELECT 
            c.id, 
            c.tipo_documento,
            c.codigo_cliente, 
            c.nombre_negocio, 
            c.direccion_limpia,
            c.ultima_compra,
            c.estatus_ruta,
            ciu.nombre AS ciudad,
            tn.nombre AS tipo_negocio
        FROM clientes c
        LEFT JOIN ciudades ciu ON c.ciudad_id = ciu.id
        LEFT JOIN tipos_negocio tn ON c.tipo_negocio_id = tn.id
        WHERE c.estatus_ruta = 'Activo'
          AND (
               c.ultima_compra IS NULL 
               OR MONTH(c.ultima_compra) != MONTH(CURDATE()) 
               OR YEAR(c.ultima_compra) != YEAR(CURDATE())
          )
        ORDER BY c.nombre_negocio ASC
    `;
    
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// RUTA 2: Activar cliente
app.post('/api/clientes/activar/:id', (req, res) => {
    const clienteId = req.params.id;
    const query = 'UPDATE clientes SET ultima_compra = CURDATE() WHERE id = ?';
    db.query(query, [clienteId], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Cliente activado' });
    });
});
// ==========================================================================
// RUTA 2: Obtener estadísticas del mes calendario para los paneles superiores
// ==========================================================================
app.get('/api/clientes/estadisticas', (req, res) => {
    // 1. Total de clientes activos en la cartera
    const qTotal = `SELECT COUNT(*) AS total FROM clientes WHERE estatus_ruta = 'Activo'`;
    
    // 2. Clientes ACTIVADOS (Compraron en el mes y año actual)
    const qActivados = `
        SELECT COUNT(*) AS activados 
        FROM clientes 
        WHERE estatus_ruta = 'Activo' 
          AND ultima_compra IS NOT NULL 
          AND MONTH(ultima_compra) = MONTH(CURDATE()) 
          AND YEAR(ultima_compra) = YEAR(CURDATE())
    `;

    db.query(qTotal, (err, resTotal) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.query(qActivados, (err, resActivados) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const total = resTotal[0].total || 0;
            const activados = resActivados[0].activados || 0;
            const faltantes = total - activados; // Los que faltan por comprar este mes
            
            // Calcular porcentaje de cobertura mensual
            const porcentaje = total > 0 ? Math.round((activados / total) * 180) : 0; 
            // Nota: Mantenemos tu meta del 180% sobre base relativa si así lo configuraste en tu diseño original

            res.json({
                porcentaje: total > 0 ? Math.round((activados / total) * 100) : 0, // Porcentaje real del mes
                activados: activados,
                faltantes: faltantes
            });
        });
    });
});
// ==========================================
// NUEVA RUTA 3: Obtener la lista de ciudades para el Combobox
// ==========================================
app.get('/api/ciudades', (req, res) => {
    // Busca el ID y el Nombre de todas las ciudades registradas en Beekeeper
    db.query('SELECT id, nombre FROM ciudades ORDER BY nombre ASC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results); // Envía la lista al formulario
    });
});

// ==========================================
// NUEVA RUTA 4: Obtener los tipos de negocio para el Combobox
// ==========================================
app.get('/api/tipos-negocio', (req, res) => {
    // Busca el ID y el Nombre de los tipos de negocio (Abasto, Bodega, etc.)
    db.query('SELECT id, nombre FROM tipos_negocio ORDER BY nombre ASC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results); // Envía la lista al formulario
    });
});

// ==========================================
// NUEVA RUTA 5: Registrar un nuevo cliente blindado
// ==========================================
app.post('/api/clientes/registrar', (req, res) => {
    // Extraemos los datos que viajan desde el formulario de la pantalla
    const { tipo_documento, codigo_cliente, nombre_negocio, direccion_limpia, ciudad_id, tipo_negocio_id } = req.body;

    // Validación extra en el servidor: Evitar que falten datos obligatorios
    if (!tipo_documento || !codigo_cliente || !nombre_negocio || !direccion_limpia || !ciudad_id || !tipo_negocio_id) {
        return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    // PASO A: Verificar primero si el número de documento ya existe en la base de datos
    const sqlCheck = 'SELECT id FROM clientes WHERE codigo_cliente = ?';
    db.query(sqlCheck, [codigo_cliente], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (rows.length > 0) {
            // Si el RIF/Cédula ya existe, frena el proceso y manda un mensaje claro
            return res.status(400).json({ error: 'Este número de documento ya está registrado en el sistema.' });
        }

        // PASO B: Si es único, procede a guardarlo con INSERT INTO
        // Nota: estatus_ruta se guarda automáticamente como 'Activo' y ultima_compra queda NULL (vacío)
        const sqlInsert = `
            INSERT INTO clientes (tipo_documento, codigo_cliente, nombre_negocio, direccion_limpia, estatus_ruta, ciudad_id, tipo_negocio_id)
            VALUES (?, ?, ?, ?, 'Activo', ?, ?)
        `;
        
        const valores = [tipo_documento, codigo_cliente, nombre_negocio, direccion_limpia, ciudad_id, tipo_negocio_id];

        db.query(sqlInsert, valores, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: '¡Cliente creado exitosamente en la ruta!' });
        });
    });
});
// ==========================================================================
// RUTA 6: Obtener TODOS los clientes activos (Sin restricción de días)
// ==========================================================================
app.get('/api/clientes/todos-activos', (req, res) => {
    const query = `
        SELECT 
            c.id, 
            c.tipo_documento,
            c.codigo_cliente, 
            c.nombre_negocio, 
            c.direccion_limpia,
            c.ultima_compra,
            c.estatus_ruta,
            ciu.nombre AS ciudad,
            tn.nombre AS tipo_negocio
        FROM clientes c
        LEFT JOIN ciudades ciu ON c.ciudad_id = ciu.id
        LEFT JOIN tipos_negocio tn ON c.tipo_negocio_id = tn.id
        WHERE c.estatus_ruta = 'Activo'
        ORDER BY c.nombre_negocio ASC
    `;
    
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});
// 1. RUTA PARA ACTUALIZAR LOS DATOS DEL CLIENTE (PUT) - ADAPTADA A SUB-TABLAS
app.put('/api/clientes/actualizar/:id', (req, res) => {
    const { id } = req.params;
    const { tipo_documento, nombre_negocio, tipo_negocio, ciudad, direccion } = req.body;

    // Buscamos dinámicamente las IDs correspondientes a los textos recibidos
    const queryIds = `
        SELECT 
            (SELECT id FROM ciudades WHERE nombre = ? LIMIT 1) AS c_id,
            (SELECT id FROM tipos_negocio WHERE nombre = ? LIMIT 1) AS n_id
    `;

    db.query(queryIds, [ciudad, tipo_negocio], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            console.error("Error al obtener IDs relacionales:", err);
            return res.status(500).json({ error: "Error al validar la ciudad o el tipo de negocio" });
        }

        const ciudadId = rows[0].c_id;
        const negocioId = rows[0].n_id;

        // Ejecutamos el UPDATE con los campos exactos de tu Beekeeper Studio
        const queryUpdate = `
            UPDATE clientes 
            SET tipo_documento = ?, nombre_negocio = ?, tipo_negocio_id = ?, ciudad_id = ?, direccion_limpia = ? 
            WHERE id = ?
        `;

        db.query(queryUpdate, [tipo_documento, nombre_negocio, negocioId, ciudadId, direccion, id], (updateErr, result) => {
            if (updateErr) {
                console.error("Error al actualizar cliente en MySQL:", updateErr);
                return res.status(500).json({ error: "Error interno del servidor al actualizar" });
            }
            res.json({ message: "Cliente actualizado exitosamente" });
        });
    });
});

// 2. RUTA PARA SACAR DE RUTA A UN CLIENTE (PUT)
app.put('/api/clientes/desactivar/:id', (req, res) => {
    const { id } = req.params;
    const query = `UPDATE clientes SET estatus_ruta = 'Inactivo' WHERE id = ?`;

    db.query(query, [id], (err, result) => {
        if (err) {
            console.error("Error al desactivar cliente en MySQL:", err);
            return res.status(500).json({ error: "Error interno del servidor al desactivar" });
        }
        res.json({ message: "Cliente removido de la ruta activa con éxito" });
    });
});

// 3. RUTA PARA ELIMINAR POR COMPLETO DE LA BASE DE DATOS (DELETE)
app.delete('/api/clientes/eliminar/:id', (req, res) => {
    const { id } = req.params;
    const query = `DELETE FROM clientes WHERE id = ?`;

    db.query(query, [id], (err, result) => {
        if (err) {
            console.error("Error al eliminar cliente de MySQL:", err);
            return res.status(500).json({ error: "Error interno del servidor al eliminar" });
        }
        res.json({ message: "Cliente eliminado permanentemente de la base de datos" });
    });
});
// ==========================================================================
// NUEVA RUTA: Obtener todos los clientes DESACTIVADOS (Fuera de ruta)
// ==========================================================================
app.get('/api/clientes/todos-inactivos', (req, res) => {
    const query = `
        SELECT 
            c.id, 
            c.tipo_documento,
            c.codigo_cliente, 
            c.nombre_negocio, 
            c.direccion_limpia,
            c.ultima_compra,
            c.estatus_ruta,
            ciu.nombre AS ciudad,
            tn.nombre AS tipo_negocio
        FROM clientes c
        LEFT JOIN ciudades ciu ON c.ciudad_id = ciu.id
        LEFT JOIN tipos_negocio tn ON c.tipo_negocio_id = tn.id
        WHERE c.estatus_ruta = 'Inactivo'
        ORDER BY c.nombre_negocio ASC
    `;
    
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ==========================================================================
// NUEVA RUTA: Reintegrar un cliente a la ruta activa
// ==========================================================================
app.put('/api/clientes/activar-ruta/:id', (req, res) => {
    const { id } = req.params;
    const query = `UPDATE clientes SET estatus_ruta = 'Activo' WHERE id = ?`;

    db.query(query, [id], (err, result) => {
        if (err) {
            console.error("Error al reintegrar cliente en MySQL:", err);
            return res.status(500).json({ error: "Error interno del servidor al reintegrar" });
        }
        res.json({ message: "Cliente reintegrado a la ruta activa con éxito" });
    });
});
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Configuración de almacenamiento temporal para el archivo subido
const upload = multer({ dest: 'uploads/' });

// ENDPOINT ULTRA ESTRICTO CON VALIDACIONES MANUALES ANTES DE CONFIRMAR
app.post('/api/clientes/importar', upload.single('archivoCsv'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se subió ningún archivo.' });
        }

        const modo = req.body.modoImportacion;
        const rutaArchivo = req.file.path;

        // Leer el archivo y limpiar filas vacías
        const contenido = fs.readFileSync(rutaArchivo, 'utf8');
        const lineas = contenido.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

        if (lineas.length <= 1) {
            if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
            return res.status(400).json({ error: 'El archivo CSV no contiene registros.' });
        }

        // Cabeceras de la Fila 1
        const cabeceras = lineas[0].split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));

        if (!cabeceras.includes('codigo_cliente') || !cabeceras.includes('nombre_negocio')) {
            if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
            return res.status(400).json({ error: 'Formato inválido. Columnas "codigo_cliente" y "nombre_negocio" requeridas.' });
        }

        // === PASO 1: LEER Y VALIDAR TODO EN MEMORIA PRIMERO ===
        const filasAProcesar = [];
        const codigosVistosEnCsv = new Set();
        const duplicadosDetectados = [];

        for (let i = 1; i < lineas.length; i++) {
            // Separar por comas respetando comillas
            const valores = lineas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.trim().replace(/^["']|["']$/g, ''));
            const fila = {};

            cabeceras.forEach((cabecera, index) => {
                fila[cabecera] = valores[index] !== undefined && valores[index] !== '' ? valores[index] : null;
            });

            // Saltar líneas completamente vacías de relleno
            if (!fila.codigo_cliente && !fila.nombre_negocio) continue;

            // ❌ VALIDACIÓN ESTRICTA 1: Código de cliente vacío o mayor a 10 dígitos
            if (!fila.codigo_cliente) {
                if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
                return res.status(400).json({ error: `Error en la fila ${i + 1}: El código de cliente está vacío.` });
            }
            if (fila.codigo_cliente.toString().length > 10) {
                if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
                return res.status(400).json({ 
                    error: `Validación fallida: El código de cliente "${fila.codigo_cliente}" (Fila ${i + 1}) supera los 10 dígitos permitidos.` 
                });
            }

            // DETECTAR DUPLICADOS EN EL PROPIO CSV
            if (codigosVistosEnCsv.has(fila.codigo_cliente)) {
                duplicadosDetectados.push(`Fila ${i + 1}: Código ${fila.codigo_cliente} (${fila.nombre_negocio || 'Sin nombre'})`);
            } else {
                codigosVistosEnCsv.add(fila.codigo_cliente);
            }

            // ❌ VALIDACIÓN ESTRICTA 2: Nombre de negocio obligatorio
            if (!fila.nombre_negocio) {
                if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
                return res.status(400).json({ error: `Validación fallida: El comercio de la fila ${i + 1} no tiene nombre de negocio.` });
            }

            // ❌ VALIDACIÓN ESTRICTA 3: Ciudad obligatoria
            if (!fila.ciudad || fila.ciudad.toLowerCase() === 'null' || fila.ciudad.trim() === '') {
                if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
                return res.status(400).json({ 
                    error: `Validación fallida: El cliente "${fila.nombre_negocio}" (Fila ${i + 1}) tiene el campo de ciudad vacío.` 
                });
            }

            // ❌ VALIDACIÓN ESTRICTA 4: Tipo de negocio obligatorio
            if (!fila.tipo_negocio || fila.tipo_negocio.toLowerCase() === 'null' || fila.tipo_negocio.trim() === '') {
                if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
                return res.status(400).json({ 
                    error: `Validación fallida: El cliente "${fila.nombre_negocio}" (Fila ${i + 1}) tiene el campo de tipo_negocio vacío.` 
                });
            }

            filasAProcesar.push(fila);
        }

        // === PASO 2: INICIAR TRANSACCIÓN SEGURA ===
        await db.promise().query('START TRANSACTION');

        if (modo === 'sobreescribir') {
            await db.promise().query('DELETE FROM clientes');
        }

        let nuevosInsertados = 0;
        let actualizadosExistentes = 0;

        for (const fila of filasAProcesar) {
            // --- BUSCAR O INSERTAR CIUDAD ---
            let ciudadId = null;
            const nombreCiudad = fila.ciudad.trim();
            const [buscarCiudad] = await db.promise().query('SELECT id FROM ciudades WHERE nombre = ?', [nombreCiudad]);
            
            if (buscarCiudad.length > 0) {
                ciudadId = buscarCiudad[0].id;
            } else {
                const [nuevaCiudad] = await db.promise().query('INSERT INTO ciudades (nombre) VALUES (?)', [nombreCiudad]);
                ciudadId = nuevaCiudad.insertId;
            }

            // --- BUSCAR O INSERTAR TIPO DE NEGOCIO ---
            let tipoNegocioId = null;
            const nombreTipo = fila.tipo_negocio.trim();
            const [buscarTipo] = await db.promise().query('SELECT id FROM tipos_negocio WHERE nombre = ?', [nombreTipo]);
            
            if (buscarTipo.length > 0) {
                tipoNegocioId = buscarTipo[0].id;
            } else {
                const [nuevoTipo] = await db.promise().query('INSERT INTO tipos_negocio (nombre) VALUES (?)', [nombreTipo]);
                tipoNegocioId = nuevoTipo.insertId;
            }

            // --- TRATAMIENTO DE FECHA Y VALORES ---
            if (!fila.ultima_compra || fila.ultima_compra.toLowerCase() === 'null' || fila.ultima_compra === 'Ninguna') {
                fila.ultima_compra = null;
            }

            const tipoDoc = fila.tipo_documento || 'V';
            const dirLimpia = fila.direccion_limpia || 'Dirección no especificada';

            const querySQL = `
                INSERT INTO clientes (tipo_documento, codigo_cliente, nombre_negocio, direccion_limpia, ultima_compra, estatus_ruta, ciudad_id, tipo_negocio_id)
                VALUES (?, ?, ?, ?, ?, 'Activo', ?, ?)
                ON DUPLICATE KEY UPDATE 
                    tipo_documento = ?, 
                    nombre_negocio = ?, 
                    direccion_limpia = ?, 
                    ultima_compra = ?, 
                    estatus_ruta = 'Activo',
                    ciudad_id = ?, 
                    tipo_negocio_id = ?
            `;

            const datosCampos = [
                tipoDoc, fila.codigo_cliente, fila.nombre_negocio, dirLimpia, fila.ultima_compra, ciudadId, tipoNegocioId,
                tipoDoc, fila.nombre_negocio, dirLimpia, fila.ultima_compra, ciudadId, tipoNegocioId
            ];

            const [resultado] = await db.promise().query(querySQL, datosCampos);
            
            if (resultado.affectedRows === 1) {
                nuevosInsertados++;
            } else {
                actualizadosExistentes++;
            }
        }

        // === PASO 3: CONFIRMAR CAMBIOS DEFINITIVOS ===
        await db.promise().query('COMMIT');

        if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
        
        res.json({ 
            mensaje: `¡Éxito! Se procesó el archivo correctamente en modo ${modo}.`,
            detallesProcesados: {
                totalEnCsv: filasAProcesar.length,
                nuevosGuardados: nuevosInsertados,
                omitidosOActualizados: actualizadosExistentes
            },
            duplicadosEnCsv: duplicadosDetectados
        });

    } catch (error) {
        // === PASO 4: CUALQUIER FALLA INESPERADA DESHACE TODO ===
        try {
            await db.promise().query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Error al hacer rollback:', rollbackError);
        }

        console.error('Error en la importación:', error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Error interno al procesar la importación.', detalles: error.message });
    }
});

// ==========================================================================
// NUEVA RUTA EXCLUSIVA: Exportar copia de seguridad completa (JSON)
// ==========================================================================
app.get('/api/sistema/respaldar', async (req, res) => {
    try {
        const [ciudades] = await db.promise().query('SELECT * FROM ciudades');
        const [tipos_negocio] = await db.promise().query('SELECT * FROM tipos_negocio');
        const [clientes] = await db.promise().query('SELECT * FROM clientes');

        const backup = {
            version: '1.0',
            fecha: new Date().toISOString(),
            ciudades,
            tipos_negocio,
            clientes
        };

        const fechaStr = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=respaldo_completo_${fechaStr}.json`);
        res.status(200).send(JSON.stringify(backup, null, 2));
    } catch (err) {
        console.error("Error al generar copia de seguridad:", err);
        res.status(500).json({ error: 'Error al generar la copia de seguridad: ' + err.message });
    }
});

// ==========================================================================
// NUEVA RUTA EXCLUSIVA: Restaurar copia de seguridad completa (JSON)
// ==========================================================================
app.post('/api/sistema/restaurar', upload.single('archivoRespaldo'), async (req, res) => {
    let rutaArchivo = null;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se subió ningún archivo de respaldo.' });
        }

        rutaArchivo = req.file.path;
        const contenido = fs.readFileSync(rutaArchivo, 'utf8');
        const backup = JSON.parse(contenido);

        if (!backup.ciudades || !backup.tipos_negocio || !backup.clientes) {
            return res.status(400).json({ error: 'El archivo de respaldo no es válido o está corrupto.' });
        }

        // Ejecutar restauración desactivando constraints de clave foránea temporalmente
        await db.promise().query('SET FOREIGN_KEY_CHECKS = 0');
        
        // Truncar tablas
        await db.promise().query('TRUNCATE TABLE clientes');
        await db.promise().query('TRUNCATE TABLE ciudades');
        await db.promise().query('TRUNCATE TABLE tipos_negocio');

        // Restaurar ciudades
        if (backup.ciudades.length > 0) {
            for (const ciudad of backup.ciudades) {
                await db.promise().query(
                    'INSERT INTO ciudades (id, nombre) VALUES (?, ?)',
                    [ciudad.id, ciudad.nombre]
                );
            }
        }

        // Restaurar tipos de negocio
        if (backup.tipos_negocio.length > 0) {
            for (const tipo of backup.tipos_negocio) {
                await db.promise().query(
                    'INSERT INTO tipos_negocio (id, nombre) VALUES (?, ?)',
                    [tipo.id, tipo.nombre]
                );
            }
        }

        // Restaurar clientes
        if (backup.clientes.length > 0) {
            for (const c of backup.clientes) {
                // Formatear fecha para evitar errores en MySQL si ultima_compra es null o inválida
                let ultimaCompra = c.ultima_compra;
                if (ultimaCompra) {
                    ultimaCompra = new Date(ultimaCompra).toISOString().slice(0, 10);
                } else {
                    ultimaCompra = null;
                }

                await db.promise().query(
                    'INSERT INTO clientes (id, tipo_documento, codigo_cliente, nombre_negocio, direccion_limpia, ultima_compra, estatus_ruta, ciudad_id, tipo_negocio_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [c.id, c.tipo_documento, c.codigo_cliente, c.nombre_negocio, c.direccion_limpia, ultimaCompra, c.estatus_ruta, c.ciudad_id, c.tipo_negocio_id]
                );
            }
        }

        await db.promise().query('SET FOREIGN_KEY_CHECKS = 1');

        if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
        res.json({ mensaje: '¡Restauración de base de datos completada con éxito!' });

    } catch (err) {
        console.error("Error al restaurar base de datos:", err);
        // Asegurarse de reactivar las llaves foráneas en caso de fallo
        try {
            await db.promise().query('SET FOREIGN_KEY_CHECKS = 1');
        } catch (_) {}
        
        if (rutaArchivo && fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
        res.status(500).json({ error: 'Error durante la restauración: ' + err.message });
    }
});

// Iniciar el servidor local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de la app corriendo localmente en http://localhost:${PORT}`);
});
