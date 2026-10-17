import type { Student } from '../../shared/domain/model';

const names = '陈一诺,张子涵,林沐阳,李嘉宁,王梓辰,赵书瑶,刘星宇,周若溪,许安然,吴景行,黄语桐,徐浩然,孙佳琪,朱奕辰,胡诗涵,郭思齐,何雨欣,高明轩,罗知夏,郑逸飞,梁可欣,谢晨曦,宋沛然,唐予安,韩泽宇,冯乐彤,曹清越,彭亦凡,曾允希,肖文博,沈念初,陆星禾,程语宁,方亦舟,蒋星辰,邓思远,任舒然,叶书禾,杜承宇,苏映月,马知礼,魏清和,姚子墨,卢晚晴,夏景初,丁予晨,余若安'.split(',');
export const demoStudents: Student[] = names.map((name, index) => ({
  id: String(index + 1), name, row: Math.floor(index / 8) + 1, col: index % 8 + 1, active: true, idSource: 'auto'
}));
