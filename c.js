const crypto = require("crypto");


function createId(bookId) {
    let str = crypto.createHash("md5").update(bookId).digest('hex');

    let strSub = str.substr(0, 3);

    let fa = function (id) {
        if (/^\d*$/['test'](id)) {
            for (var len = id['length'], c = [], a = 0; a < len; a += 9) {
                var b = id['slice'](a, Math.min(a + 9, len));
                c['push'](parseInt(b)['toString'](16));
            }
            return ['3', c];
        }
        for (var d = '', i = 0; i < id['length']; i++) {
            d += id['charCodeAt'](i)['toString'](16);
        }
        return ['4', [d]];

    }(bookId);

    strSub += fa[0],
        strSub += 2 + str['substr'](str['length'] - 2, 2);
    for (var m = fa[1], j = 0; j < m.length; j++) {
        var n = m[j].length.toString(16);
        1 === n['length'] && (n = '0' + n),
            strSub += n,
            strSub += m[j],
            j < m['length'] - 1 && (strSub += 'g');
    }
    return strSub.length < 20 && (strSub += str.substr(0, 20 - strSub.length)),
        strSub += crypto.createHash("md5").update(strSub).digest('hex').substr(0, 3);;
}

function parseId(infoId) {
    const type = infoId[3];
    // skip: 3 (md5 prefix) + 1 (type) + 3 ("2" + md5 suffix 2 chars) = 7 chars
    const dataSection = infoId.slice(7, infoId.length - 3); // remove trailing 3-char checksum

    const segments = dataSection.split('g');
    const chunks = [];
    for (const seg of segments) {
        const len = parseInt(seg.slice(0, 2), 16);
        chunks.push(seg.slice(2, 2 + len));
    }

    if (type === '3') {
        // numeric bookId: each chunk is parseInt(9-digit-group).toString(16)
        return chunks.map(c => parseInt(c, 16).toString(10)).join('');
    } else if (type === '4') {
        // string bookId: full hex string of charCodes
        const hex = chunks[0];
        let result = '';
        for (let i = 0; i < hex.length; i += 2) {
            result += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        }
        return result;
    }
    throw new Error(`Unknown type flag: ${type}`);
}

// let strId = createId("3300085132")
// console.log('encoded:', strId);
console.log('decoded:', parseId("0e542af224d505f5758535f3330303236303338333296c"));